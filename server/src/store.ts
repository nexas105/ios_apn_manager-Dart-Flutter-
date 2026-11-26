// Token store: user id → device tokens, on SQLite (built into Node, no native modules).

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ApnsEnvironment } from "./config.ts";
import type { Platform, Target } from "./types.ts";

export interface StoredToken extends Target {
  userId: string;
  createdAt: string;
  updatedAt: string;
  lastSuccessAt: string | null;
  failureCount: number;
  lastError: string | null;
}

interface Row {
  token: string;
  user_id: string;
  platform: Platform;
  environment: ApnsEnvironment | null;
  created_at: string;
  updated_at: string;
  last_success_at: string | null;
  failure_count: number;
  last_error: string | null;
}

export class TokenStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS push_tokens (
        token            TEXT PRIMARY KEY,
        user_id          TEXT NOT NULL,
        platform         TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
        environment      TEXT CHECK (environment IN ('sandbox', 'production')),
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        last_success_at  TEXT,
        failure_count    INTEGER NOT NULL DEFAULT 0,
        last_error       TEXT
      );
      CREATE INDEX IF NOT EXISTS push_tokens_user ON push_tokens (user_id);
    `);
  }

  /** Inserts or moves a token to [userId] (a device token belongs to exactly one user). */
  upsert(userId: string, t: Target): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO push_tokens (token, user_id, platform, environment, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (token) DO UPDATE SET
           user_id = excluded.user_id, platform = excluded.platform,
           environment = excluded.environment, updated_at = excluded.updated_at,
           failure_count = 0, last_error = NULL`,
      )
      .run(t.token, userId, t.platform, t.environment ?? null, now, now);
  }

  /** Removes a token. With [userId], only if it belongs to that user. Returns whether a row was deleted. */
  remove(token: string, userId?: string): boolean {
    const r =
      userId === undefined
        ? this.db.prepare("DELETE FROM push_tokens WHERE token = ?").run(token)
        : this.db.prepare("DELETE FROM push_tokens WHERE token = ? AND user_id = ?").run(token, userId);
    return Number(r.changes) > 0;
  }

  tokensForUser(userId: string): StoredToken[] {
    const rows = this.db
      .prepare("SELECT * FROM push_tokens WHERE user_id = ? ORDER BY updated_at DESC")
      .all(userId) as unknown as Row[];
    return rows.map((r) => ({
      token: r.token,
      userId: r.user_id,
      platform: r.platform,
      environment: r.environment ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastSuccessAt: r.last_success_at,
      failureCount: r.failure_count,
      lastError: r.last_error,
    }));
  }

  /**
   * Records a delivery outcome. Only tokens the provider reported as definitely
   * invalid are deleted; other failures are kept (they may be config errors).
   */
  recordResult(token: string, ok: boolean, error: string | undefined, invalid: boolean): void {
    if (invalid) {
      this.remove(token);
      return;
    }
    const now = new Date().toISOString();
    if (ok) {
      this.db
        .prepare("UPDATE push_tokens SET last_success_at = ?, failure_count = 0, last_error = NULL WHERE token = ?")
        .run(now, token);
      return;
    }
    this.db
      .prepare("UPDATE push_tokens SET failure_count = failure_count + 1, last_error = ? WHERE token = ?")
      .run(error ?? null, token);
  }

  /** Stores the APNs environment that actually worked for this token. */
  setEnvironment(token: string, environment: ApnsEnvironment): void {
    this.db.prepare("UPDATE push_tokens SET environment = ? WHERE token = ?").run(environment, token);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}
