// Minimal JSON-lines logger. Never log titles, bodies or full tokens.

import { createHash } from "node:crypto";
import type { LogLevel } from "./config.ts";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = ORDER.info;

export function setLogLevel(level: LogLevel): void {
  threshold = ORDER[level];
}

function write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });
  if (ORDER[level] >= ORDER.warn) process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => write("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => write("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => write("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => write("error", msg, f),
};

/** Short, stable hash for user ids in logs (never log them in clear text). */
export function hashId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 10);
}

/** First 8 characters of a device token, enough to correlate in logs. */
export function maskToken(token: string): string {
  return token.length <= 8 ? "…" : `${token.slice(0, 8)}…`;
}
