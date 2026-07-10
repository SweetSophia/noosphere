/**
 * In-process sliding-window fallback for rate limiting when Redis is unavailable.
 *
 * Design:
 * - Sliding-window counter per client+prefix key, mirroring the Redis ZSET approach.
 * - Kept warm on every request so Redis outages do not reset the allowance.
 * - Stored in a Map with periodic pruning to prevent unbounded memory growth.
 * - Hard cap on entry count to bound memory under IP-rotation attacks. When
 *   saturated with live entries, unknown keys are denied instead of evicting
 *   active buckets and reopening their allowance.
 * - Conservative: same windowMs and maxRequests as the Redis path.
 * - Intentionally simple — this is a defense-in-depth last resort, not a
 *   replacement for the Redis-backed limiter.
 */

interface FallbackEntry {
  /** Timestamps of requests within the current window (ms since epoch). */
  timestamps: number[];
  /** The windowMs this entry was created with, used for correct sweep filtering. */
  windowMs: number;
}

export type FallbackDecision =
  | "allowed"
  | "limit-exceeded"
  | "capacity-saturated";

const MIN_SWEEP_INTERVAL_MS = 30_000;
const MAX_ENTRIES = 10_000;

class InProcessRateLimiter {
  private readonly entries = new Map<string, FallbackEntry>();
  private lastSweep = Date.now();

  /**
   * Check whether a request should be allowed under the in-process fallback.
   * Mutates state by recording the request timestamp when allowed.
   */
  check(
    key: string,
    windowMs: number,
    maxRequests: number,
    now: number
  ): FallbackDecision {
    this.maybeSweep(now);

    const entry = this.entries.get(key);

    if (entry) {
      // The current call is authoritative if a route changes its configured
      // window. This mirrors Redis's use of the current windowStart value.
      entry.timestamps = entry.timestamps.filter((t) => t > now - windowMs);
      entry.windowMs = windowMs;
    }

    const currentCount = entry?.timestamps.length ?? 0;

    if (currentCount >= maxRequests) {
      return "limit-exceeded";
    }

    // Record this request.
    if (entry) {
      entry.timestamps.push(now);
    } else {
      // maybeSweep() already performs bounded-frequency reclamation. If the
      // map is still saturated, deny the unknown key: rescanning on every new
      // key would create a CPU DoS, while eviction would reset active buckets.
      if (this.entries.size >= MAX_ENTRIES) {
        return "capacity-saturated";
      }
      this.entries.set(key, { timestamps: [now], windowMs });
    }

    return "allowed";
  }

  /** Remove the request recorded during warm-up when healthy Redis rejects it. */
  rollback(key: string, timestamp: number): void {
    const entry = this.entries.get(key);
    if (!entry) return;

    const index = entry.timestamps.lastIndexOf(timestamp);
    if (index === -1) return;

    entry.timestamps.splice(index, 1);
    if (entry.timestamps.length === 0) {
      this.entries.delete(key);
    }
  }

  /** Remove fully-expired entries to bound memory. Called at most every 30 s. */
  private maybeSweep(now: number): void {
    if (now - this.lastSweep < MIN_SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;

    this.sweepExpired(now);
  }

  private sweepExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      const alive = entry.timestamps.filter((t) => t > now - entry.windowMs);
      if (alive.length === 0) {
        this.entries.delete(key);
      } else {
        entry.timestamps = alive;
      }
    }
  }

  /** Test-only: reset internal state. */
  reset(): void {
    this.entries.clear();
    this.lastSweep = Date.now();
  }

  /** Test-only: current entry count. */
  get size(): number {
    return this.entries.size;
  }
}

const inProcessRateLimiter = new InProcessRateLimiter();

/** Production surface: only request accounting is exposed. */
export const fallbackLimiter = {
  check(
    key: string,
    windowMs: number,
    maxRequests: number,
    now: number
  ): FallbackDecision {
    return inProcessRateLimiter.check(key, windowMs, maxRequests, now);
  },
  rollback(key: string, timestamp: number): void {
    inProcessRateLimiter.rollback(key, timestamp);
  },
};

/** Test-only inspection hooks, matching the Redis module's convention. */
export const _fallbackLimiterTestHooks = {
  reset(): void {
    inProcessRateLimiter.reset();
  },
  get size(): number {
    return inProcessRateLimiter.size;
  },
  get capacity(): number {
    return MAX_ENTRIES;
  },
};
