// In-memory fixed-window rate limiter (per process; good enough for one container).

export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(limit: number, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Returns 0 if allowed, otherwise the seconds until the next window. */
  take(key: string, now = Date.now()): number {
    if (this.hits.size > 10_000) this.prune(now);
    const h = this.hits.get(key);
    if (!h || now >= h.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return 0;
    }
    if (h.count >= this.limit) return Math.ceil((h.resetAt - now) / 1000);
    h.count++;
    return 0;
  }

  private prune(now: number): void {
    for (const [k, h] of this.hits) if (now >= h.resetAt) this.hits.delete(k);
  }
}
