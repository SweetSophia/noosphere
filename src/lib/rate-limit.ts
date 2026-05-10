import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();
let lastCleanup = 0;

function cleanupExpired() {
  const now = Date.now();
  // Throttle cleanup to once per minute to avoid O(N) scan on every request
  if (now - lastCleanup < 60_000) return;
  lastCleanup = now;
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) {
      store.delete(key);
    }
  }
}

function getClientIdentifier(request: NextRequest): string {
  // Prefer request.ip (set by the platform/runtime) over x-forwarded-for
  // to prevent clients from spoofing their rate-limit identity.
  // Only fall back to x-forwarded-for when request.ip is unavailable.
  return request.ip ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  keyPrefix?: string;
}

/**
 * Simple in-memory fixed-window rate limiter.
 * For production scale, replace with Redis-backed limiter.
 */
export function rateLimit(
  request: NextRequest,
  options: RateLimitOptions
): { allowed: true } | { allowed: false; response: NextResponse } {
  cleanupExpired();

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
