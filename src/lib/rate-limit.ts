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

export async function rateLimit(
  request: NextRequest,
  options: RateLimitOptions
): Promise<{ allowed: true } | { allowed: false; response: NextResponse }> {
  const clientId = getClientIdentifier(request);
  const key = `ratelimit:${options.keyPrefix ?? "default"}:${clientId}`;
  const now = Date.now();
  const windowStart = now - options.windowMs;

  const redis = getRedisClient();

  if (!redis) {
    return { allowed: true };
  }

  try {
    const pipeline = redis.pipeline();
    pipeline.zremrangebyscore(key, "-inf", windowStart.toString());
    pipeline.zcard(key);
    pipeline.zadd(key, now, `${now}:${crypto.randomUUID()}`);
    pipeline.expire(key, Math.ceil(options.windowMs / 1000) + 1);

    const results = await pipeline.exec();
    if (!results) {
      return { allowed: true };
    }

    // results[1] is [error, zcard result] — index 1 is the count from zcard
    const countResult = results[1];
    const count = (countResult[1] as number) ?? 0;

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
