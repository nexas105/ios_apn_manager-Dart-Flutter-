// Sends one message to many targets and records the outcome in the token store.

import type { ApnsEnvironment } from "./config.ts";
import { log, maskToken } from "./log.ts";
import type { TokenStore } from "./store.ts";
import type { ApnsSender, DeliveryResult, FcmSender, Platform, PushMessage, Target } from "./types.ts";

export interface DispatchDeps {
  apns?: ApnsSender;
  fcm?: FcmSender;
  apnsDefaultEnvironment: ApnsEnvironment;
  store?: TokenStore;
}

export interface TargetResult {
  /** Masked token (first 8 chars). */
  token: string;
  platform: Platform;
  ok: boolean;
  error?: string;
  /** The token was invalid and has been removed from the store. */
  invalidToken?: boolean;
  environment?: ApnsEnvironment;
}

export interface DispatchResult {
  sent: number;
  failed: number;
  results: TargetResult[];
}

const CONCURRENCY = 10;

/** Errors that point at the server configuration rather than the token. */
const CONFIG_HINTS: Record<string, string> = {
  DeviceTokenNotForTopic: "APNS_BUNDLE_ID does not match the app that created this token",
  InvalidProviderToken:
    "Apple rejected the .p8 key: check APNS_KEY_ID and APNS_TEAM_ID, and that the key has APNs enabled " +
    "(App Store Connect API keys are also named AuthKey_<id>.p8 but cannot send pushes)",
  ExpiredProviderToken: "the server clock is probably wrong",
  SENDER_ID_MISMATCH: "the FCM service account belongs to a different Firebase project than the app",
  THIRD_PARTY_AUTH_ERROR: "APNs credentials uploaded to Firebase are invalid or missing",
  fcm_auth_error: "the FCM service account could not get an OAuth token (wrong or revoked key?)",
};

async function sendApns(
  apns: ApnsSender,
  t: Target,
  msg: PushMessage,
  defaultEnv: ApnsEnvironment,
): Promise<DeliveryResult & { environment: ApnsEnvironment }> {
  const env = t.environment ?? defaultEnv;
  const first = await apns.send(t.token, env, msg);
  if (first.error !== "BadDeviceToken") return { ...first, environment: env };
  // A sandbox token sent to production (or vice versa) yields BadDeviceToken.
  // Try the other environment once before declaring the token dead.
  const other: ApnsEnvironment = env === "sandbox" ? "production" : "sandbox";
  const second = await apns.send(t.token, other, msg);
  if (second.error === "BadDeviceToken") return { ...second, invalidToken: true, environment: other };
  return { ...second, environment: other };
}

async function sendOne(t: Target, msg: PushMessage, deps: DispatchDeps): Promise<TargetResult> {
  let r: DeliveryResult & { environment?: ApnsEnvironment };
  if (t.platform === "ios") {
    r = deps.apns
      ? await sendApns(deps.apns, t, msg, deps.apnsDefaultEnvironment)
      : { ok: false, status: 0, error: "apns_not_configured", invalidToken: false };
  } else {
    r = deps.fcm
      ? await deps.fcm.send(t.token, msg)
      : { ok: false, status: 0, error: "fcm_not_configured", invalidToken: false };
  }

  const notConfigured = r.error === "apns_not_configured" || r.error === "fcm_not_configured";
  if (deps.store && !notConfigured) {
    try {
      deps.store.recordResult(t.token, r.ok, r.error, r.invalidToken);
      if (r.ok && t.platform === "ios" && r.environment && r.environment !== t.environment) {
        deps.store.setEnvironment(t.token, r.environment);
      }
    } catch (e) {
      log.warn("store update failed", { err: (e as Error).message });
    }
  }
  if (!r.ok) {
    const level = r.error && r.error in CONFIG_HINTS ? "warn" : "info";
    log[level]("delivery failed", {
      platform: t.platform,
      token: maskToken(t.token),
      status: r.status,
      error: r.error,
      invalidToken: r.invalidToken,
      hint: r.error ? CONFIG_HINTS[r.error] : undefined,
    });
  }
  return {
    token: maskToken(t.token),
    platform: t.platform,
    ok: r.ok,
    ...(r.error ? { error: r.error } : {}),
    ...(r.invalidToken ? { invalidToken: true } : {}),
    ...(t.platform === "ios" && r.environment ? { environment: r.environment } : {}),
  };
}

export async function dispatch(targets: Target[], msg: PushMessage, deps: DispatchDeps): Promise<DispatchResult> {
  const results: TargetResult[] = new Array(targets.length);
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const i = next++;
      results[i] = await sendOne(targets[i]!, msg, deps);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  const sent = results.filter((r) => r.ok).length;
  return { sent, failed: results.length - sent, results };
}
