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
  return rateLimitIdentifier(getClientIdentifier(request), options);
}

export async function rateLimitIdentifier(
  clientId: string,
  options: RateLimitOptions
): Promise<{ allowed: true } | { allowed: false; response: NextResponse }> {
  const key = `ratelimit:${options.keyPrefix ?? "default"}:${clientId}`;
  const now = Date.now();
  const windowStart = now - options.windowMs;

  const redis = getRedisClient();

  if (!redis) {
    return { allowed: true };
  }

  try {
    const pipeline = redis.pipeline();

    const member = `${now}:${randomUUID()}`;

    pipeline.zremrangebyscore(key, "-inf", windowStart.toString());
    pipeline.zadd(key, now, member);
    pipeline.zcard(key);
    pipeline.expire(key, Math.ceil(options.windowMs / 1000) + 1);

    const results = await pipeline.exec();

    if (!results) {
      return { allowed: true };
    }

    const countResult = results[2];
    if (countResult[0]) {
      return { allowed: true };
    }

    const currentCount = countResult[1] as number;

    if (currentCount > options.maxRequests) {
      await redis.zrem(key, member);
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
