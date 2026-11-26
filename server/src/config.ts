// Reads and validates all configuration from environment variables.
// See ../.env.example for the documented list.

import { readFileSync } from "node:fs";

export type ApnsEnvironment = "sandbox" | "production";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface ApnsConfig {
  /** PEM contents of the .p8 key (PKCS#8). */
  key: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  /** Used for tokens that were registered/sent without an explicit environment. */
  defaultEnvironment: ApnsEnvironment;
}

export interface FcmServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
}

export interface FcmConfig {
  serviceAccount: FcmServiceAccount;
  projectId: string;
  /** Android notification channel id. The plugin creates `erohub_default`. */
  androidChannelId: string;
}

export interface JwtConfig {
  secret?: string;
  jwksUrl?: string;
  issuer?: string;
  audience?: string;
  /** Claim that holds the user id (default `sub`). */
  userClaim: string;
}

export interface Config {
  host: string;
  port: number;
  adminApiKey: string;
  clientApiKey?: string;
  allowClientSend: boolean;
  /** Max client-initiated sends per sender per minute. */
  clientSendRateLimit: number;
  trustProxy: boolean;
  jwt?: JwtConfig;
  apns?: ApnsConfig;
  fcm?: FcmConfig;
  store: { enabled: boolean; path: string };
  maxBodyBytes: number;
  logLevel: LogLevel;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function str(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

function bool(env: Env, name: string, def: boolean): boolean {
  const v = str(env, name)?.toLowerCase();
  if (v === undefined) return def;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new ConfigError(`${name} must be true or false, got "${v}"`);
}

function int(env: Env, name: string, def: number, min = 0): number {
  const v = str(env, name);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) {
    throw new ConfigError(`${name} must be an integer >= ${min}, got "${v}"`);
  }
  return n;
}

/**
 * Secrets can be given as a file path (`<NAME>_PATH`) or inline (`<NAME>`).
 * Inline values may use literal `\n` for line breaks or be base64 encoded.
 */
function secretFromEnv(
  env: Env,
  inlineName: string,
  pathName: string,
  looksValid: (s: string) => boolean,
): string | undefined {
  const path = str(env, pathName);
  const inline = str(env, inlineName);
  if (path && inline) {
    throw new ConfigError(`Set either ${inlineName} or ${pathName}, not both`);
  }
  if (path) {
    try {
      return readFileSync(path, "utf8").trim();
    } catch (e) {
      throw new ConfigError(`${pathName}: cannot read "${path}" (${(e as Error).message})`);
    }
  }
  if (!inline) return undefined;
  const unescaped = inline.replace(/\\n/g, "\n").trim();
  if (looksValid(unescaped)) return unescaped;
  const decoded = Buffer.from(inline, "base64").toString("utf8").trim();
  if (looksValid(decoded)) return decoded;
  throw new ConfigError(`${inlineName} is neither a valid value nor base64 of one`);
}

const PLACEHOLDER = /^(change-?me|changeme|xxx+|your[-_].*)$/i;

function apiKey(env: Env, name: string, required: boolean): string | undefined {
  const v = str(env, name);
  if (!v) {
    if (required) throw new ConfigError(`${name} is required (generate one with: npm run gen-key)`);
    return undefined;
  }
  if (PLACEHOLDER.test(v)) throw new ConfigError(`${name} still has its placeholder value`);
  if (v.length < 24) throw new ConfigError(`${name} must be at least 24 characters`);
  return v;
}

function loadApns(env: Env): ApnsConfig | undefined {
  const key = secretFromEnv(env, "APNS_KEY", "APNS_KEY_PATH", (s) => s.includes("BEGIN PRIVATE KEY"));
  const keyId = str(env, "APNS_KEY_ID");
  const teamId = str(env, "APNS_TEAM_ID");
  const bundleId = str(env, "APNS_BUNDLE_ID");
  const any = key || keyId || teamId || bundleId;
  if (!any) return undefined;
  const missing = [
    !key && "APNS_KEY or APNS_KEY_PATH",
    !keyId && "APNS_KEY_ID",
    !teamId && "APNS_TEAM_ID",
    !bundleId && "APNS_BUNDLE_ID",
  ].filter(Boolean);
  if (missing.length) throw new ConfigError(`APNs is partially configured, missing: ${missing.join(", ")}`);
  const envName = (str(env, "APNS_ENVIRONMENT") ?? "sandbox").toLowerCase();
  if (envName !== "sandbox" && envName !== "production") {
    throw new ConfigError(`APNS_ENVIRONMENT must be sandbox or production, got "${envName}"`);
  }
  return { key: key!, keyId: keyId!, teamId: teamId!, bundleId: bundleId!, defaultEnvironment: envName };
}

function loadFcm(env: Env): FcmConfig | undefined {
  const raw = secretFromEnv(env, "FCM_SERVICE_ACCOUNT_JSON", "FCM_SERVICE_ACCOUNT_PATH", (s) => s.startsWith("{"));
  if (!raw) return undefined;
  let sa: FcmServiceAccount;
  try {
    sa = JSON.parse(raw) as FcmServiceAccount;
  } catch {
    throw new ConfigError("FCM service account is not valid JSON");
  }
  if (!sa.client_email || !sa.private_key) {
    throw new ConfigError("FCM service account JSON lacks client_email or private_key");
  }
  const projectId = str(env, "FCM_PROJECT_ID") ?? sa.project_id;
  if (!projectId) throw new ConfigError("FCM_PROJECT_ID is required (not found in the service account)");
  return {
    serviceAccount: sa,
    projectId,
    androidChannelId: str(env, "FCM_ANDROID_CHANNEL_ID") ?? "erohub_default",
  };
}

function loadJwt(env: Env): JwtConfig | undefined {
  const secret = str(env, "JWT_SECRET");
  const jwksUrl = str(env, "JWT_JWKS_URL");
  if (!secret && !jwksUrl) return undefined;
  if (secret && jwksUrl) throw new ConfigError("Set either JWT_SECRET or JWT_JWKS_URL, not both");
  if (jwksUrl) {
    try {
      new URL(jwksUrl);
    } catch {
      throw new ConfigError(`JWT_JWKS_URL is not a valid URL: "${jwksUrl}"`);
    }
  }
  return {
    secret,
    jwksUrl,
    issuer: str(env, "JWT_ISSUER"),
    audience: str(env, "JWT_AUDIENCE"),
    userClaim: str(env, "JWT_USER_CLAIM") ?? "sub",
  };
}

export function loadConfig(env: Env = process.env): Config {
  const adminApiKey = apiKey(env, "ADMIN_API_KEY", true)!;
  const clientApiKey = apiKey(env, "CLIENT_API_KEY", false);
  if (clientApiKey && clientApiKey === adminApiKey) {
    throw new ConfigError("CLIENT_API_KEY must differ from ADMIN_API_KEY");
  }
  const tokenStore = (str(env, "TOKEN_STORE") ?? "sqlite").toLowerCase();
  if (tokenStore !== "sqlite" && tokenStore !== "none") {
    throw new ConfigError(`TOKEN_STORE must be sqlite or none, got "${tokenStore}"`);
  }
  const logLevel = (str(env, "LOG_LEVEL") ?? "info").toLowerCase() as LogLevel;
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    throw new ConfigError(`LOG_LEVEL must be debug, info, warn or error`);
  }
  return {
    host: str(env, "HOST") ?? "0.0.0.0",
    port: int(env, "PORT", 8080, 1),
    adminApiKey,
    clientApiKey,
    allowClientSend: bool(env, "ALLOW_CLIENT_SEND", false),
    clientSendRateLimit: int(env, "CLIENT_SEND_RATE_LIMIT", 30, 1),
    trustProxy: bool(env, "TRUST_PROXY", false),
    jwt: loadJwt(env),
    apns: loadApns(env),
    fcm: loadFcm(env),
    store: { enabled: tokenStore === "sqlite", path: str(env, "DATABASE_PATH") ?? "./data/push.db" },
    maxBodyBytes: int(env, "MAX_BODY_BYTES", 64 * 1024, 1024),
    logLevel,
  };
}
