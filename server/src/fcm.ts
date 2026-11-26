// Firebase Cloud Messaging HTTP v1 with a service account (OAuth2 JWT bearer flow).
// https://firebase.google.com/docs/cloud-messaging/send/v1-api

import { SignJWT, importPKCS8, type CryptoKey } from "jose";
import type { FcmConfig } from "./config.ts";
import type { DeliveryResult, FcmSender, PushMessage } from "./types.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const REQUEST_TIMEOUT_MS = 10_000;

const ERROR_CODES = new Set([
  "UNREGISTERED", "INVALID_ARGUMENT", "NOT_FOUND", "SENDER_ID_MISMATCH", "QUOTA_EXCEEDED",
  "UNAVAILABLE", "INTERNAL", "THIRD_PARTY_AUTH_ERROR", "PERMISSION_DENIED", "UNAUTHENTICATED",
]);

export function fcmErrorCode(status: number, body: string): string {
  try {
    const err = (JSON.parse(body) as { error?: { status?: unknown; details?: unknown } }).error;
    // The specific FcmError code (e.g. UNREGISTERED) lives in details and wins over the generic status.
    if (Array.isArray(err?.details)) {
      for (const d of err.details as Array<{ errorCode?: unknown }>) {
        if (typeof d?.errorCode === "string" && ERROR_CODES.has(d.errorCode)) return d.errorCode;
      }
    }
    if (typeof err?.status === "string" && ERROR_CODES.has(err.status)) return err.status;
  } catch {
    /* not JSON */
  }
  if (status === 404) return "NOT_FOUND";
  return `fcm_${status}`;
}

export function fcmInvalidToken(status: number, code: string, body: string): boolean {
  // SENDER_ID_MISMATCH usually means the wrong service account/project: never delete for it.
  if (code === "UNREGISTERED") return true;
  if (status === 404 || code === "NOT_FOUND") return true;
  // INVALID_ARGUMENT is also returned for bad payloads; only treat it as a dead token
  // when the message points at the registration token.
  return code === "INVALID_ARGUMENT" && /registration token/i.test(body);
}

/** FCM data values must be strings. */
export function stringifyData(data: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

export function buildFcmMessage(token: string, msg: PushMessage, channelId: string): Record<string, unknown> {
  const notification: Record<string, unknown> = { channel_id: channelId };
  if (msg.sound !== null) notification.sound = msg.sound ?? "default";
  if (msg.badge !== undefined) notification.notification_count = msg.badge;
  if (msg.collapseId) notification.tag = msg.collapseId;
  const android: Record<string, unknown> = { priority: "HIGH", notification };
  if (msg.collapseId) android.collapse_key = msg.collapseId;
  if (msg.ttlSeconds !== undefined) android.ttl = `${msg.ttlSeconds}s`;
  return {
    message: {
      token,
      notification: { title: msg.title, body: msg.body },
      data: stringifyData(msg.data),
      android,
    },
  };
}

export class FcmClient implements FcmSender {
  private readonly config: FcmConfig;
  private keyPromise: Promise<CryptoKey> | undefined;
  private accessToken: { value: string; expiresAt: number } | undefined;
  private pendingToken: Promise<string> | undefined;
  private readonly tokenUrl: string;
  private readonly apiBase: string;

  /** Endpoints can be overridden for tests. */
  constructor(config: FcmConfig, endpoints: { tokenUrl?: string; apiBase?: string } = {}) {
    this.config = config;
    this.tokenUrl = endpoints.tokenUrl ?? TOKEN_URL;
    this.apiBase = endpoints.apiBase ?? "https://fcm.googleapis.com";
  }

  /** Fetches an OAuth token once so a broken service account fails at startup. */
  async verifyCredentials(): Promise<void> {
    await this.oauthToken();
  }

  private async oauthToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessToken.expiresAt - 60_000) return this.accessToken.value;
    // Collapse concurrent refreshes into one request.
    this.pendingToken ??= this.fetchToken().finally(() => (this.pendingToken = undefined));
    return this.pendingToken;
  }

  private async fetchToken(): Promise<string> {
    const sa = this.config.serviceAccount;
    this.keyPromise ??= importPKCS8(sa.private_key, "RS256");
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(sa.client_email)
      .setSubject(sa.client_email)
      .setAudience(TOKEN_URL)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(await this.keyPromise);
    const res = await fetch(this.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(`FCM OAuth failed: HTTP ${res.status} ${err.error ?? ""}`.trim());
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return json.access_token;
  }

  async send(token: string, msg: PushMessage): Promise<DeliveryResult> {
    let accessToken: string;
    try {
      accessToken = await this.oauthToken();
    } catch {
      return { ok: false, status: 0, error: "fcm_auth_error", invalidToken: false };
    }
    let res: Response;
    try {
      res = await fetch(`${this.apiBase}/v1/projects/${encodeURIComponent(this.config.projectId)}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify(buildFcmMessage(token, msg, this.config.androidChannelId)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      const error = (e as Error).name === "TimeoutError" ? "fcm_timeout" : "fcm_network_error";
      return { ok: false, status: 0, error, invalidToken: false };
    }
    if (res.ok) {
      await res.body?.cancel();
      return { ok: true, status: res.status, invalidToken: false };
    }
    const text = await res.text();
    const code = fcmErrorCode(res.status, text);
    if (res.status === 401) this.accessToken = undefined;
    return { ok: false, status: res.status, error: code, invalidToken: fcmInvalidToken(res.status, code, text) };
  }

  close(): void {}
}
