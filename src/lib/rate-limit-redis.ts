import type Redis from "ioredis";

interface RedisRateLimitOptions {
  key: string;
  windowMs: number;
  maxRequests: number;
  now: number;
  member?: string;
}

/** Grace period (seconds) added to the computed TTL to prevent edge-case
 *  races where the key expires between ZADD and EXPIRE. */
const TTL_GRACE_SECONDS = 1;

// Redis executes Lua scripts atomically, so concurrent app instances cannot
// both observe the same pre-limit count and over-admit requests.
const REDIS_RATE_LIMIT_SCRIPT = `
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
local count = redis.call("ZCARD", KEYS[1])

if count >= tonumber(ARGV[3]) then
  return 0
end

redis.call("ZADD", KEYS[1], ARGV[2], ARGV[4])
redis.call("EXPIRE", KEYS[1], ARGV[5])
return 1
`;

/**
 * Atomically prune, count, and conditionally record a request in Redis.
 * Returns null for an unexpected Redis response so the caller can use its
 * already-warmed in-process fallback rather than trusting malformed state.
 */
export async function checkRedisRateLimit(
  redis: Pick<Redis, "eval">,
  options: RedisRateLimitOptions
): Promise<boolean | null> {
  const result = await redis.eval(
    REDIS_RATE_LIMIT_SCRIPT,
    1,
    options.key,
    options.now - options.windowMs,
    options.now,
    options.maxRequests,
    options.member ?? `${options.now}:${crypto.randomUUID()}`,
    Math.ceil(options.windowMs / 1000) + TTL_GRACE_SECONDS
  );

  if (result === 1 || result === "1") return true;
  if (result === 0 || result === "0") return false;
  return null;
}
