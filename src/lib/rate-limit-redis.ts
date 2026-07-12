import { createHash } from "node:crypto";
import type Redis from "ioredis";
import { invalidateRedisClient } from "@/lib/cache/redis";

interface RedisRateLimitOptions {
  key: string;
  windowMs: number;
  maxRequests: number;
  now: number;
  member?: string;
  timeoutMs?: number;
}

/** Grace period (seconds) added to the TTL so the EXPIRE window always
 *  strictly exceeds `windowMs`. `Math.ceil(windowMs / 1000)` can equal the
 *  window's effective lifetime to-the-second (e.g. 60 000 ms → 60 s), and
 *  Redis EXPIRE rounds to the second, so without +1 the key could expire
 *  the instant the oldest in-window entry becomes queryable-out-of-window. */
const TTL_GRACE_SECONDS = 1;

/** Maximum time to wait for a Redis eval response before falling back.
 *  Covers wedged-socket scenarios where the client is "ready" but the
 *  connection is stuck mid-command. */
const EVAL_TIMEOUT_MS = 1500;

// Redis executes Lua scripts atomically, so concurrent app instances cannot
// both observe the same pre-limit count and over-admit requests.
export const REDIS_RATE_LIMIT_SCRIPT = `
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
local count = redis.call("ZCARD", KEYS[1])

if count >= tonumber(ARGV[3]) then
  return 0
end

redis.call("ZADD", KEYS[1], ARGV[2], ARGV[4])
redis.call("EXPIRE", KEYS[1], ARGV[5])
return 1
`;

const SCRIPT_SHA = createHash("sha1").update(REDIS_RATE_LIMIT_SCRIPT).digest("hex");
/**
 * Atomically prune, count, and conditionally record a request in Redis.
 *
 * Uses EVALSHA with automatic EVAL fallback (manual evalsha/eval on NOSCRIPT,
 * matching ioredis's built-in behaviour) to avoid re-sending the script body
 * on every call.  The entire eval is wrapped in a timeout to handle
 * wedged-socket scenarios where the client reports "ready" but the connection
 * is stuck mid-command.
 *
 * On timeout, the Redis client is disconnected so the next `getReadyRedisClient()`
 * rebuilds a fresh connection rather than queueing commands onto a dead socket.
 *
 * Returns null for an unexpected Redis response so the caller can use its
 * already-warmed in-process fallback rather than trusting malformed state.
 * Throws on timeout or Redis error so the caller's catch block routes to
 * the degraded path.
 */
export async function checkRedisRateLimit(
  redis: Pick<Redis, "eval" | "evalsha" | "disconnect">,
  options: RedisRateLimitOptions
): Promise<boolean | null> {
  const args: Array<string | number> = [
    options.key,
    options.now - options.windowMs,
    options.now,
    options.maxRequests,
    options.member ?? `${options.now}:${crypto.randomUUID()}`,
    Math.ceil(options.windowMs / 1000) + TTL_GRACE_SECONDS,
  ];

  // Abort context prevents the EVAL fallback from firing after the outer
  // timeout race has already settled (H2: avoids counter drift from late
  // NOSCRIPT → EVAL writes against a connection the caller abandoned).
  const ctx = { aborted: false };

  const evalPromise = evalWithFallback(redis, args, ctx);

  const timeoutMs = options.timeoutMs ?? EVAL_TIMEOUT_MS;
  const result = await timeoutRace(evalPromise, timeoutMs, options.key, () => {
    ctx.aborted = true;
    // Force the client to reconnect on next call.  Without this, a wedged
    // but status="ready" socket silently queues every subsequent command (H1).
    invalidateRedisClient(redis);
  });

  if (result === 1 || result === "1") return true;
  if (result === 0 || result === "0") return false;
  console.warn("[rate-limit-redis] Unexpected script result", { key: options.key, result });
  return null;
}

/**
 * Try EVALSHA first; on NOSCRIPT error (script evicted from Redis cache),
 * fall back to EVAL.  This mirrors ioredis's built-in behaviour but gives
 * us explicit control over the fallback path.
 *
 * The abort context prevents issuing a follow-up EVAL after the outer timeout
 * race has already settled (H2).
 */
async function evalWithFallback(
  redis: Pick<Redis, "eval" | "evalsha">,
  args: Array<string | number>,
  ctx: { aborted: boolean }
): Promise<number | string> {
  try {
    return (await redis.evalsha(SCRIPT_SHA, 1, ...args)) as number | string;
  } catch (err: unknown) {
    // If the outer race already timed out, do NOT issue a follow-up EVAL —
    // the caller has moved on and a late write would cause counter drift.
    if (ctx.aborted) throw err;
    // NOSCRIPT means Redis doesn't have the script cached.  Fall back to EVAL.
    if (err instanceof Error && /NOSCRIPT/i.test(err.message)) {
      // Keep this check next to the mutating fallback call. It makes the
      // invariant explicit and prevents a later refactor from inserting an
      // async boundary between the catch-level guard and EVAL.
      if (ctx.aborted) throw err;
      const result = (await redis.eval(
        REDIS_RATE_LIMIT_SCRIPT,
        1,
        ...args
      )) as number | string;
      // A command already written to Redis cannot be recalled. If the timeout
      // fired while EVAL was in flight, discard its late result and let the
      // warmed per-process limiter decide the request. The script may consume
      // one Redis slot even if that local decision differs, but removing it
      // would be unsafe: the local path may have allowed this request, and
      // other instances rely on the shared counter.
      if (ctx.aborted) throw err;
      return result;
    }
    throw err;
  }
}

/**
 * Race the eval promise against a timeout.  If the timeout fires, the
 * in-flight Redis promise may still reject later (broken pipe, cluster
 * failover, etc.).  We attach a no-op catch to prevent that late rejection
 * from surfacing as an unhandled promise rejection — but only AFTER the
 * race is settled, so the first rejection still propagates correctly.
 */
async function timeoutRace(
  promise: Promise<number | string>,
  timeoutMs: number,
  key: string,
  onTimeout?: () => void
): Promise<number | string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Abort and invalidate before settling the race. Promise reactions run
      // after this timer callback returns, so no queued NOSCRIPT handler or
      // subsequent caller can observe the abandoned client as usable.
      try {
        onTimeout?.();
      } catch (error) {
        // Cleanup must not replace the command-timeout error seen by callers.
        console.error("Redis timeout cleanup error:", error);
      }
      reject(new Error(`Redis eval timed out after ${timeoutMs}ms (key: ${key})`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    // The race is over.  Silently consume any late rejection from the loser
    // so it doesn't surface as an unhandled promise rejection.
    promise.catch(() => {});
  }
}
