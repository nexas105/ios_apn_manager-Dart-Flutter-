// Apple Push Notification service over HTTP/2 with token-based (.p8) auth.
// https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns

import http2 from "node:http2";
import { SignJWT, importPKCS8, type CryptoKey } from "jose";
import type { ApnsConfig, ApnsEnvironment } from "./config.ts";
import type { ApnsSender, DeliveryResult, PushMessage } from "./types.ts";

const HOSTS: Record<ApnsEnvironment, string> = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

const REQUEST_TIMEOUT_MS = 10_000;
// Apple: refresh no more often than every 20 min, tokens older than 60 min are rejected.
const JWT_TTL_MS = 50 * 60_000;

const ERROR_CODES = new Set([
  "BadCollapseId", "BadDeviceToken", "BadExpirationDate", "BadMessageId", "BadPriority",
  "BadTopic", "DeviceTokenNotForTopic", "DuplicateHeaders", "IdleTimeout", "InvalidPushType",
  "MissingDeviceToken", "MissingTopic", "PayloadEmpty", "TopicDisallowed", "BadCertificate",
  "BadCertificateEnvironment", "ExpiredProviderToken", "Forbidden", "InvalidProviderToken",
  "MissingProviderToken", "BadPath", "MethodNotAllowed", "ExpiredToken", "Unregistered",
  "PayloadTooLarge", "TooManyProviderTokenUpdates", "TooManyRequests", "InternalServerError",
  "ServiceUnavailable", "Shutdown",
]);

export function apnsErrorCode(status: number, body: string): string {
  try {
    const reason = (JSON.parse(body) as { reason?: unknown }).reason;
    if (typeof reason === "string" && ERROR_CODES.has(reason)) return reason;
  } catch {
    /* not JSON */
  }
  if (status === 410) return "Unregistered";
  return `apns_${status}`;
}

/**
 * Whether the token itself is dead. `BadDeviceToken` is only final after the other
 * environment was tried too (see dispatch.ts); `DeviceTokenNotForTopic` usually means
 * a wrong APNS_BUNDLE_ID, so it never deletes tokens.
 */
export function apnsInvalidToken(status: number, code: string): boolean {
  return status === 410 || code === "Unregistered" || code === "BadDeviceToken";
}

/** Builds the JSON body. Custom data goes to top-level keys next to `aps`. */
export function buildApnsPayload(msg: PushMessage): Record<string, unknown> {
  const aps: Record<string, unknown> = { alert: { title: msg.title, body: msg.body } };
  if (msg.sound !== null) aps.sound = msg.sound ?? "default";
  if (msg.badge !== undefined) aps.badge = msg.badge;
  if (msg.threadId) aps["thread-id"] = msg.threadId;
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(msg.data ?? {})) {
    if (k !== "aps" && v !== undefined) payload[k] = v;
  }
  payload.aps = aps;
  return payload;
}

export class ApnsClient implements ApnsSender {
  private readonly config: ApnsConfig;
  private readonly sessions = new Map<ApnsEnvironment, http2.ClientHttp2Session>();
  private keyPromise: Promise<CryptoKey> | undefined;
  private jwt: { value: string; createdAt: number } | undefined;
  private readonly hosts: Record<ApnsEnvironment, string>;

  /** [hosts] can be overridden for tests (e.g. a local h2c server). */
  constructor(config: ApnsConfig, hosts: Record<ApnsEnvironment, string> = HOSTS) {
    this.config = config;
    this.hosts = hosts;
  }

  /** Fails fast on a malformed .p8 key (called at startup). */
  async verifyKey(): Promise<void> {
    await this.providerToken();
  }

  private async providerToken(): Promise<string> {
    if (this.jwt && Date.now() - this.jwt.createdAt < JWT_TTL_MS) return this.jwt.value;
    this.keyPromise ??= importPKCS8(this.config.key, "ES256");
    const key = await this.keyPromise;
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: this.config.keyId })
      .setIssuer(this.config.teamId)
      .setIssuedAt()
      .sign(key);
    this.jwt = { value, createdAt: Date.now() };
    return value;
  }

  private session(env: ApnsEnvironment): http2.ClientHttp2Session {
    const existing = this.sessions.get(env);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const s = http2.connect(this.hosts[env]);
    const drop = () => {
      if (this.sessions.get(env) === s) this.sessions.delete(env);
    };
    s.on("error", drop);
    s.on("goaway", drop);
    s.on("close", drop);
    this.sessions.set(env, s);
    return s;
  }

  async send(token: string, env: ApnsEnvironment, msg: PushMessage): Promise<DeliveryResult> {
    const body = JSON.stringify(buildApnsPayload(msg));
    const headers: http2.OutgoingHttpHeaders = {
      ":method": "POST",
      ":path": `/3/device/${encodeURIComponent(token)}`,
      authorization: `bearer ${await this.providerToken()}`,
      "apns-topic": this.config.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    };
    if (msg.collapseId) headers["apns-collapse-id"] = msg.collapseId;
    if (msg.ttlSeconds !== undefined) {
      headers["apns-expiration"] = String(Math.floor(Date.now() / 1000) + msg.ttlSeconds);
    }

    let res: { status: number; text: string };
    try {
      res = await this.request(env, headers, body);
    } catch (e) {
      if (e instanceof ApnsTimeout) return { ok: false, status: 0, error: "apns_timeout", invalidToken: false };
      // Stale connection (GOAWAY race), nothing was delivered: retry once on a fresh session.
      this.dropSession(env);
      try {
        res = await this.request(env, headers, body);
      } catch (e2) {
        const error = e2 instanceof ApnsTimeout ? "apns_timeout" : "apns_network_error";
        return { ok: false, status: 0, error, invalidToken: false };
      }
    }
    if (res.status === 200) return { ok: true, status: 200, invalidToken: false };
    const code = apnsErrorCode(res.status, res.text);
    if (code === "ExpiredProviderToken" || code === "InvalidProviderToken") this.jwt = undefined;
    return { ok: false, status: res.status, error: code, invalidToken: apnsInvalidToken(res.status, code) };
  }

  private dropSession(env: ApnsEnvironment): void {
    this.sessions.get(env)?.destroy();
    this.sessions.delete(env);
  }

  private request(
    env: ApnsEnvironment,
    headers: http2.OutgoingHttpHeaders,
    body: string,
  ): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };
      const req = this.session(env).request(headers);
      let status = 0;
      let text = "";
      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        settle(() => reject(new ApnsTimeout()));
        req.close(http2.constants.NGHTTP2_CANCEL);
      });
      req.setEncoding("utf8");
      req.on("response", (h) => (status = Number(h[":status"] ?? 0)));
      req.on("data", (chunk: string) => (text += chunk));
      req.on("end", () =>
        settle(() => (status ? resolve({ status, text }) : reject(new Error("APNs stream ended without status")))),
      );
      req.on("error", (e) => settle(() => reject(e)));
      req.on("close", () => settle(() => reject(new Error("APNs stream closed"))));
      req.end(body);
    });
  }

  close(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }
}

class ApnsTimeout extends Error {}
