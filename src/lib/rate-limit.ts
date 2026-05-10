import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

function cleanupExpired() {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) {
      store.delete(key);
    }
  }
}

function getClientIdentifier(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() ?? request.ip ?? "unknown";
  return ip;
}

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  keyPrefix?: string;
}

/**
 * Simple in-memory sliding-window rate limiter.
 * For production scale, replace with Redis-backed limiter.
 */
export function rateLimit(
  request: NextRequest,
  options: RateLimitOptions
): { allowed: true } | { allowed: false; response: NextResponse } {
  if (store.size > 10_000) {
    cleanupExpired();
  }

  const clientId = getClientIdentifier(request);
  const key = `${options.keyPrefix ?? "rl"}:${clientId}`;
  const now = Date.now();

  const entry = store.get(key);
  if (!entry || entry.resetAt <= now) {
    store.set(key, {
      count: 1,
      resetAt: now + options.windowMs,
    });
    return { allowed: true };
  }

  if (entry.count >= options.maxRequests) {
    return {
      allowed: false,
      response: apiError("Too many requests", 429),
    };
  }

  entry.count += 1;
  return { allowed: true };
}
