import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { getRedisClient } from "@/lib/cache/redis";

interface RateLimitOptions {
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

export function rateLimit(
  request: NextRequest,
  options: RateLimitOptions
): { allowed: true } | { allowed: false; response: NextResponse } {
  const clientId = getClientIdentifier(request);
  const key = `ratelimit:${options.keyPrefix ?? "default"}:${clientId}`;
  const now = Date.now();
  const windowStart = now - options.windowMs;

  const redis = getRedisClient();

  if (!redis) {
    return { allowed: true };
  }

  try {
    redis.zremrangebyscore(key, "-inf", windowStart.toString());
    const count = redis.zcard(key);
    const member = `${now}:${crypto.randomUUID()}`;
    redis.zadd(key, now, member);
    redis.expire(key, Math.ceil(options.windowMs / 1000) + 1);

    if (count >= options.maxRequests) {
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
