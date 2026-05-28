import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { apiError } from "@/lib/api/errors";
import { getRedisClient } from "@/lib/cache/redis";

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  keyPrefix?: string;
}

function getClientIdentifier(request: NextRequest): string {
  return (
    request.headers.get("x-real-ip") ??
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

export async function rateLimit(
  request: NextRequest,
  options: RateLimitOptions
): Promise<{ allowed: true } | { allowed: false; response: NextResponse }> {
  return rateLimitInternal(getClientIdentifier(request), options);
}

/**
 * Internal rate limiter using an atomic Lua script.
 * All operations (trim, add, count, expire, conditional remove) execute
 * atomically on the Redis server, eliminating pipeline race conditions.
 */
async function rateLimitInternal(
  clientId: string,
  options: RateLimitOptions
): Promise<{ allowed: true } | { allowed: false; response: NextResponse }> {
  const key = `ratelimit:${options.keyPrefix ?? "default"}:${clientId}`;
  const now = Date.now();
  const windowStart = now - options.windowMs;
  const member = `${now}:${randomUUID()}`;
  const ttlSeconds = Math.ceil(options.windowMs / 1000) + 1;

  const redis = getRedisClient();

  if (!redis) {
    return { allowed: true };
  }

  // Atomic Lua script:
  // 1. Trim expired entries
  // 2. Add current request
  // 3. Count entries
  // 4. Set TTL
  // 5. If over limit, remove the entry we just added and return blocked
  const luaScript = `
    redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[1])
    redis.call('zadd', KEYS[1], ARGV[2], ARGV[3])
    local count = redis.call('zcard', KEYS[1])
    redis.call('expire', KEYS[1], ARGV[4])
    if count > tonumber(ARGV[5]) then
      redis.call('zrem', KEYS[1], ARGV[3])
      return {0, count}
    end
    return {1, count}
  `;

  try {
    const result = (await redis.eval(
      luaScript,
      1,
      key,
      windowStart.toString(),
      now.toString(),
      member,
      ttlSeconds.toString(),
      options.maxRequests.toString()
    )) as [number, number];

    if (!Array.isArray(result) || result.length < 2) {
      console.error("Rate limiter: unexpected Lua response", result);
      return { allowed: true };
    }

    const allowed = result[0] === 1;

    if (!allowed) {
      return {
        allowed: false,
        response: apiError("Too many requests", 429),
      };
    }

    return { allowed: true };
  } catch (error) {
    console.error("Rate limiter error:", error);
    return { allowed: true };
  }
}

/**
 * Rate-limit by raw client identifier (for contexts without a NextRequest,
 * such as NextAuth credentials authorization).
 */
export async function rateLimitIdentifier(
  clientId: string,
  options: RateLimitOptions
): Promise<{ allowed: true } | { allowed: false; response: NextResponse }> {
  return rateLimitInternal(clientId, options);
}
