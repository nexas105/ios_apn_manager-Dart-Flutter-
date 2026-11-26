// HTTP API. Routes:
//   GET    /health                    no auth
//   POST   /v1/tokens                 admin | client   register a device token for a user
//   DELETE /v1/tokens/:token          admin | client   remove a device token
//   POST   /v1/send                   admin | client*  send to a user (token store) or to explicit tokens
//   GET    /v1/users/:userId/tokens   admin            list a user's tokens (masked)
// * clients only with ALLOW_CLIENT_SEND=true, only by userId, rate-limited.

import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { AuthError, type Authenticator, type Principal } from "./auth.ts";
import type { ApnsEnvironment, Config } from "./config.ts";
import { dispatch, type DispatchDeps } from "./dispatch.ts";
import { hashId, log, maskToken } from "./log.ts";
import { RateLimiter } from "./ratelimit.ts";
import type { TokenStore } from "./store.ts";
import type { Platform, PushMessage, Target } from "./types.ts";

export interface AppDeps extends DispatchDeps {
  config: Pick<Config, "allowClientSend" | "clientSendRateLimit" | "trustProxy" | "maxBodyBytes">;
  auth: Authenticator;
  store?: TokenStore;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Record<string, string>;
  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

const bad = (message: string) => new HttpError(400, "invalid_request", message);

// ─── Validation ────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optString(o: Json, key: string, max: number): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw bad(`"${key}" must be a string`);
  if (v.length > max) throw bad(`"${key}" is longer than ${max} characters`);
  return v;
}

function reqString(o: Json, key: string, max: number): string {
  const v = optString(o, key, max);
  if (!v) throw bad(`"${key}" is required`);
  return v;
}

function optInt(o: Json, key: string, min: number, max: number): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw bad(`"${key}" must be an integer between ${min} and ${max}`);
  }
  return v;
}

function parsePlatform(v: unknown): Platform {
  if (v === "ios" || v === "android") return v;
  throw bad(`"platform" must be "ios" or "android"`);
}

function parseEnvironment(v: unknown): ApnsEnvironment | undefined {
  if (v === undefined || v === null) return undefined;
  if (v === "sandbox" || v === "production") return v;
  throw bad(`"environment" must be "sandbox" or "production"`);
}

const IOS_TOKEN = /^[0-9a-fA-F]{32,512}$/;
const FCM_TOKEN = /^[\w:.\-]{20,4096}$/;

export function parseTarget(v: unknown): Target {
  if (!isObject(v)) throw bad("token entries must be objects");
  const token = reqString(v, "token", 4096);
  const platform = parsePlatform(v.platform);
  if (platform === "ios" && !IOS_TOKEN.test(token)) throw bad("iOS token must be the hex APNs device token");
  if (platform === "android" && !FCM_TOKEN.test(token)) throw bad("Android token does not look like an FCM token");
  const environment = platform === "ios" ? parseEnvironment(v.environment) : undefined;
  return { token, platform, ...(environment ? { environment } : {}) };
}

export function parseMessage(o: Json): PushMessage {
  const title = optString(o, "title", 1024) ?? "";
  const body = optString(o, "body", 4096) ?? "";
  if (!title && !body) throw bad(`"title" or "body" is required`);
  const data = o.data;
  if (data !== undefined && data !== null && !isObject(data)) throw bad(`"data" must be an object`);
  const sound = o.sound === null ? null : optString(o, "sound", 256);
  const msg: PushMessage = { title, body };
  if (isObject(data)) msg.data = data;
  const badge = optInt(o, "badge", 0, 1_000_000);
  if (badge !== undefined) msg.badge = badge;
  if (sound !== undefined) msg.sound = sound;
  const collapseId = optString(o, "collapseId", 64);
  if (collapseId) msg.collapseId = collapseId;
  const threadId = optString(o, "threadId", 256);
  if (threadId) msg.threadId = threadId;
  const ttl = optInt(o, "ttlSeconds", 0, 28 * 24 * 3600);
  if (ttl !== undefined) msg.ttlSeconds = ttl;
  return msg;
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

async function readJson(req: IncomingMessage, limit: number): Promise<Json> {
  const type = req.headers["content-type"] ?? "";
  if (type && !/^application\/json\b/i.test(type)) {
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "payload_too_large", `Body exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw bad("Body is not valid JSON");
  }
  if (!isObject(parsed)) throw bad("Body must be a JSON object");
  return parsed;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(text);
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers["x-forwarded-for"];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

// ─── Handlers ──────────────────────────────────────────────────────────────

/** For clients with a verified JWT, the user id comes from the token and may not be overridden. */
function resolveUserId(p: Principal, requested: string | undefined): string {
  if (p.role === "client" && p.userId !== undefined) {
    if (requested !== undefined && requested !== p.userId) {
      throw new HttpError(403, "forbidden", "userId does not match the authenticated user");
    }
    return p.userId;
  }
  if (!requested) throw bad(`"userId" is required`);
  return requested;
}

function requireStore(deps: AppDeps): TokenStore {
  if (!deps.store) throw new HttpError(400, "token_store_disabled", "Token store is disabled (TOKEN_STORE=none)");
  return deps.store;
}

async function registerToken(req: IncomingMessage, p: Principal, deps: AppDeps) {
  const store = requireStore(deps);
  const body = await readJson(req, deps.config.maxBodyBytes);
  const userId = resolveUserId(p, optString(body, "userId", 256));
  const target = parseTarget(body);
  store.upsert(userId, target);
  log.info("token registered", { user: hashId(userId), platform: target.platform, token: maskToken(target.token) });
  return { status: 200, body: { ok: true } };
}

function deleteToken(token: string, p: Principal, deps: AppDeps) {
  const store = requireStore(deps);
  if (!token) throw bad("token missing in path");
  const onlyFor = p.role === "client" ? p.userId : undefined;
  const removed = store.remove(token, onlyFor);
  return { status: 200, body: { ok: true, removed } };
}

async function send(req: IncomingMessage, p: Principal, deps: AppDeps, limiter: RateLimiter) {
  const body = await readJson(req, deps.config.maxBodyBytes);
  const hasTokens = body.tokens !== undefined;
  const requestedUser = optString(body, "userId", 256);

  if (p.role === "client") {
    if (!deps.config.allowClientSend) {
      throw new HttpError(403, "client_send_disabled", "Sending with the client key is disabled (ALLOW_CLIENT_SEND)");
    }
    if (hasTokens) throw new HttpError(403, "forbidden", "Clients can only send by userId");
    const key = p.userId ? `user:${p.userId}` : `ip:${clientIp(req, deps.config.trustProxy)}`;
    const retryAfter = limiter.take(key);
    if (retryAfter > 0) {
      throw new HttpError(429, "rate_limited", "Too many sends, slow down", { "retry-after": String(retryAfter) });
    }
  }

  if (hasTokens === (requestedUser !== undefined)) throw bad(`Provide exactly one of "userId" or "tokens"`);
  const message = parseMessage(body);

  let targets: Target[];
  let logUser: string | undefined;
  if (hasTokens) {
    if (!Array.isArray(body.tokens) || body.tokens.length === 0) throw bad(`"tokens" must be a non-empty array`);
    if (body.tokens.length > 500) throw bad(`"tokens" may contain at most 500 entries`);
    targets = body.tokens.map(parseTarget);
  } else {
    const userId = requestedUser!;
    logUser = hashId(userId);
    targets = requireStore(deps).tokensForUser(userId);
    if (targets.length === 0) {
      log.info("send: no tokens", { user: logUser });
      return { status: 200, body: { sent: 0, failed: 0, results: [], reason: "no_tokens" } };
    }
  }

  const result = await dispatch(targets, message, deps);
  log.info("send", { user: logUser, by: p.role, targets: targets.length, sent: result.sent, failed: result.failed });
  return { status: 200, body: result };
}

function listTokens(userId: string, deps: AppDeps) {
  const tokens = requireStore(deps)
    .tokensForUser(userId)
    .map((t) => ({ ...t, token: maskToken(t.token) }));
  return { status: 200, body: { userId, tokens } };
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw bad("Malformed URL encoding");
  }
}

// ─── Router ────────────────────────────────────────────────────────────────

export function createApp(deps: AppDeps): RequestListener {
  const limiter = new RateLimiter(deps.config.clientSendRateLimit);

  async function route(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    if (path === "/health") {
      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method_not_allowed", "Use GET");
      return { status: 200, body: { status: "ok" } };
    }

    const tokenMatch = /^\/v1\/tokens\/([^/]+)$/.exec(path);
    const usersMatch = /^\/v1\/users\/([^/]+)\/tokens$/.exec(path);
    const known = path === "/v1/tokens" || path === "/v1/send" || tokenMatch || usersMatch;
    if (!known) throw new HttpError(404, "not_found", "Not found");

    const principal = await deps.auth.authenticate(req);

    if (path === "/v1/tokens") {
      if (method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST");
      return registerToken(req, principal, deps);
    }
    if (tokenMatch) {
      if (method !== "DELETE") throw new HttpError(405, "method_not_allowed", "Use DELETE");
      return deleteToken(decodeSegment(tokenMatch[1]!), principal, deps);
    }
    if (path === "/v1/send") {
      if (method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST");
      return send(req, principal, deps, limiter);
    }
    if (method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET");
    if (principal.role !== "admin") throw new HttpError(403, "forbidden", "Admin key required");
    return listTokens(decodeSegment(usersMatch![1]!), deps);
  }

  return (req, res) => {
    const started = Date.now();
    route(req)
      .then(({ status, body }) => sendJson(res, status, body))
      .catch((e: unknown) => {
        if (e instanceof HttpError) sendJson(res, e.status, { error: e.code, message: e.message }, e.headers);
        else if (e instanceof AuthError) sendJson(res, e.status, { error: e.code, message: e.message });
        else {
          log.error("unhandled error", { err: e instanceof Error ? e.message : String(e) });
          sendJson(res, 500, { error: "internal_error", message: "Internal server error" });
        }
      })
      .finally(() => {
        const path = (req.url ?? "").split("?")[0]!
          .replace(/^\/v1\/tokens\/.+/, "/v1/tokens/:token")
          .replace(/^\/v1\/users\/[^/]+/, "/v1/users/:userId");
        log.debug("request", { method: req.method, path, status: res.statusCode, ms: Date.now() - started });
      });
  };
}
