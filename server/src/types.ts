import type { ApnsEnvironment } from "./config.ts";

export type Platform = "ios" | "android";

/** Provider-neutral notification content. */
export interface PushMessage {
  title: string;
  body: string;
  /** Custom key/values. Delivered as top-level keys on iOS and as FCM data (strings) on Android. */
  data?: Record<string, unknown>;
  badge?: number;
  /** Sound name, `default` if omitted. `null` sends a silent-sound alert. */
  sound?: string | null;
  /** APNs collapse id / FCM collapse key. */
  collapseId?: string;
  /** iOS notification grouping (aps.thread-id). */
  threadId?: string;
  /** How long the provider should keep retrying delivery. */
  ttlSeconds?: number;
}

export interface Target {
  token: string;
  platform: Platform;
  environment?: ApnsEnvironment;
}

export interface DeliveryResult {
  ok: boolean;
  /** Provider status code (0 on network errors). */
  status: number;
  /** Allow-listed provider error code, never a raw provider body. */
  error?: string;
  /** The token is permanently invalid and should be removed. */
  invalidToken: boolean;
}

export interface Sender<Args extends unknown[]> {
  send(...args: Args): Promise<DeliveryResult>;
  close(): Promise<void> | void;
}

export type ApnsSender = Sender<[token: string, environment: ApnsEnvironment, message: PushMessage]>;
export type FcmSender = Sender<[token: string, message: PushMessage]>;
