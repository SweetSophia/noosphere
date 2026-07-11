import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { apiError } from "@/lib/api/errors";
import { getReadyRedisClient } from "@/lib/cache/redis";
import {
  fallbackLimiter,
  type FallbackDecision,
} from "@/lib/rate-limit-fallback";
import { checkRedisRateLimit } from "@/lib/rate-limit-redis";

interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  keyPrefix?: string;
}

const MAX_IDENTIFIER_LENGTH = 256;

function getClientIdentifier(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  // Cap before parsing so a multi-kilobyte x-forwarded-for doesn't waste CPU
  // on split/trim.  1 024 bytes is generous for any legitimate proxy chain.
  const rawIdentifier = (
    request.headers.get("x-real-ip") ??
    request.headers.get("cf-connecting-ip") ??
    (xff ? xff.slice(0, 1024).split(",")[0]?.trim() : null) ??
    "unknown"
  ).trim();

  if (!rawIdentifier) return "unknown";
  if (isIP(rawIdentifier)) return rawIdentifier.toLowerCase();

  // Proxy headers are untrusted. Short-circuit oversized values before
  // hashing to avoid wasting CPU on attacker-controlled kilobyte-scale headers.
  if (rawIdentifier.length > MAX_IDENTIFIER_LENGTH) return "invalid:oversized";

  // Hash remaining invalid values so a request cannot pin many kilobytes of
  // attacker-controlled text in every fallback Map key.
  return `invalid:${createHash("sha256")
    .update(rawIdentifier)
    .digest("base64url")}`;
}

let outageWarningLogged = false;
let firstErrorLogged = false;

function warnFallbackEngaged(reason: string, error?: unknown): void {
  if (!outageWarningLogged) {
    console.warn(
      `[rate-limit] Redis unavailable (${reason}); relying on in-process limiter. ` +
        "Rate limiting will be per-process, not shared across instances."
    );
    outageWarningLogged = true;
  }
  // Always log the first error of each degradation window, even if the
  // banner was already printed via a no-error path.
  if (error !== undefined && !firstErrorLogged) {
    console.error("Rate limiter error:", error);
    firstErrorLogged = true;
  }
}

function markRedisResponded(): void {
  // Note: the in-process fallback Map still holds timestamps accumulated during
  // the outage.  For up to `windowMs` after recovery the local guard may deny
  // requests that Redis would allow, because the stale local entries have not
  // yet expired.  This is an acceptable trade-off: the alternative (clearing
  // the Map on recovery) would briefly allow every client to exceed the shared
  // limit at the recovery boundary.
  outageWarningLogged = false;
  firstErrorLogged = false;
}

function rateLimitExceeded(
  windowMs: number
): { allowed: false; response: NextResponse } {
  const response = apiError("Too many requests", 429);
  // Tell clients when to retry..ceil ensures we never under-report
  // the wait time due to sub-second rounding.
  response.headers.set("Retry-After", String(Math.ceil(windowMs / 1000)));
  return { allowed: false, response };
}

function degradedResult(
  fallbackDecision: FallbackDecision,
  windowMs: number
): { allowed: true } | { allowed: false; response: NextResponse } {
  // A saturated map cannot safely track a previously unseen key. Healthy
  // Redis can still decide it, but during degradation we must fail closed.
  return fallbackDecision === "capacity-saturated"
    ? rateLimitExceeded(windowMs)
    : { allowed: true };
}

export async function rateLimit(
  request: NextRequest,
  options: RateLimitOptions
): Promise<{ allowed: true } | { allowed: false; response: NextResponse }> {
  const clientId = getClientIdentifier(request);
  const key = `ratelimit:${options.keyPrefix ?? "default"}:${clientId}`;
  const now = Date.now();
  // Keep the fallback warm on every request. Redis remains the shared,
  // cross-process authority; this local guard preserves recent request state
  // if Redis becomes unavailable between two requests.
  const fallbackDecision = fallbackLimiter.check(
    key,
    options.windowMs,
    options.maxRequests,
    now
  );
  if (fallbackDecision === "limit-exceeded") {
    return rateLimitExceeded(options.windowMs);
  }

  const redis = await getReadyRedisClient();

  if (!redis) {
    warnFallbackEngaged("client not ready");
    return degradedResult(fallbackDecision, options.windowMs);
  }

  try {
    const redisAllowed = await checkRedisRateLimit(redis, {
      key,
      windowMs: options.windowMs,
      maxRequests: options.maxRequests,
      now,
    });

    if (redisAllowed === null) {
      warnFallbackEngaged("atomic check returned invalid result");
      return degradedResult(fallbackDecision, options.windowMs);
    }

    markRedisResponded();

    if (!redisAllowed) {
      if (fallbackDecision === "allowed") {
        fallbackLimiter.rollback(key, now);
      }
      return rateLimitExceeded(options.windowMs);
    }

    return { allowed: true };
  } catch (error) {
    warnFallbackEngaged("atomic check threw", error);
    return degradedResult(fallbackDecision, options.windowMs);
  }
}

export const _rateLimitTestHooks = {
  resetDegradationState(): void {
    outageWarningLogged = false;
    firstErrorLogged = false;
  },
};
