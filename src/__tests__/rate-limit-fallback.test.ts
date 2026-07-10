import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "assert";
import { rateLimit, _rateLimitTestHooks } from "@/lib/rate-limit";
import {
  fallbackLimiter,
  _fallbackLimiterTestHooks,
} from "@/lib/rate-limit-fallback";
import { _redisTestHooks } from "@/lib/cache/redis";
import { NextRequest } from "next/server";
import { FakeRedisClient } from "./_helpers/fake-redis";

function makeRequest(ip: string = "192.168.1.1"): NextRequest {
  return new NextRequest("http://localhost/api/test", {
    headers: { "x-real-ip": ip },
  });
}

describe("Rate Limiter Fallback (in-process, Redis unavailable)", () => {
  let previousRedisUrl: string | undefined;

  beforeEach(() => {
    // Ensure Redis is fully unset so the fallback path runs.
    previousRedisUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    _redisTestHooks.reset();
    _fallbackLimiterTestHooks.reset();
    _rateLimitTestHooks.resetDegradationState();
  });

  afterEach(() => {
    _redisTestHooks.reset();
    _fallbackLimiterTestHooks.reset();
    _rateLimitTestHooks.resetDegradationState();
    if (previousRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = previousRedisUrl;
    }
  });

  it("allows requests within limit when Redis is down", async () => {
    const request = makeRequest("10.0.0.50");
    const result = await rateLimit(request, {
      windowMs: 60_000,
      maxRequests: 5,
      keyPrefix: "fallback-allow",
    });
    assert.deepStrictEqual(result, { allowed: true });
  });

  it("blocks requests exceeding limit when Redis is down", async () => {
    const request = makeRequest("10.0.0.51");
    const options = {
      windowMs: 60_000,
      maxRequests: 3,
      keyPrefix: "fallback-block",
    };

    assert.deepStrictEqual(await rateLimit(request, options), { allowed: true });
    assert.deepStrictEqual(await rateLimit(request, options), { allowed: true });
    assert.deepStrictEqual(await rateLimit(request, options), { allowed: true });

    const result = await rateLimit(request, options);
    assert.equal(result.allowed, false);
    if (!result.allowed) {
      assert.equal(result.response.status, 429);
    }
  });

  it("tracks different IPs independently in fallback mode", async () => {
    const options = {
      windowMs: 60_000,
      maxRequests: 2,
      keyPrefix: "fallback-ip",
    };

    const req1 = makeRequest("10.0.0.52");
    const req2 = makeRequest("10.0.0.53");

    assert.deepStrictEqual(await rateLimit(req1, options), { allowed: true });
    assert.deepStrictEqual(await rateLimit(req1, options), { allowed: true });
    assert.equal((await rateLimit(req1, options)).allowed, false);

    // Different IP has its own counter.
    assert.deepStrictEqual(await rateLimit(req2, options), { allowed: true });
  });

  it("tracks different key prefixes independently in fallback mode", async () => {
    const request = makeRequest("10.0.0.54");

    await rateLimit(request, {
      windowMs: 60_000,
      maxRequests: 1,
      keyPrefix: "fallback-prefix-a",
    });
    const result = await rateLimit(request, {
      windowMs: 60_000,
      maxRequests: 1,
      keyPrefix: "fallback-prefix-b",
    });

    assert.deepStrictEqual(result, { allowed: true });
  });

  it("returns 429 with correct status code in fallback mode", async () => {
    const request = makeRequest("10.0.0.55");
    const options = {
      windowMs: 60_000,
      maxRequests: 1,
      keyPrefix: "fallback-429",
    };

    await rateLimit(request, options);
    const result = await rateLimit(request, options);

    assert.equal(result.allowed, false);
    if (!result.allowed) {
      assert.equal(result.response.status, 429);
    }
  });

  it("enforces the limit across concurrent fallback requests", async () => {
    const request = makeRequest("10.0.0.56");
    const options = {
      windowMs: 60_000,
      maxRequests: 3,
      keyPrefix: "fallback-concurrent",
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => rateLimit(request, options))
    );

    assert.equal(results.filter((result) => result.allowed).length, 3);
    assert.equal(results.filter((result) => !result.allowed).length, 7);
  });
});

describe("Rate Limiter Fallback (Redis failures)", () => {
  let fakeRedis: FakeRedisClient;

  beforeEach(() => {
    fakeRedis = new FakeRedisClient();
    _redisTestHooks.setClientForTesting(fakeRedis as never);
    _fallbackLimiterTestHooks.reset();
    _rateLimitTestHooks.resetDegradationState();
  });

  afterEach(() => {
    _redisTestHooks.reset();
    _fallbackLimiterTestHooks.reset();
    _rateLimitTestHooks.resetDegradationState();
  });

  it("falls back to in-process limiter when the atomic check returns invalid data", async () => {
    fakeRedis.eval = async () => null as never;

    const request = makeRequest("10.0.0.60");
    const options = { windowMs: 60_000, maxRequests: 1, keyPrefix: "pipe-null" };

    // First request: invalid Redis response → warmed fallback allows.
    assert.deepStrictEqual(await rateLimit(request, options), { allowed: true });

    // Second request: fallback blocks (bucket full).
    const result2 = await rateLimit(request, options);
    assert.equal(result2.allowed, false);
  });

  it("falls back to in-process limiter when the atomic check throws", async () => {
    fakeRedis.eval = async () => {
      throw new Error("Redis connection lost");
    };

    const request = makeRequest("10.0.0.61");
    const options = { windowMs: 60_000, maxRequests: 1, keyPrefix: "pipe-throw" };

    // Suppress expected error log.
    const origConsoleError = console.error;
    console.error = () => {};

    try {
      // First request: Redis throws → warmed fallback allows.
      assert.deepStrictEqual(await rateLimit(request, options), { allowed: true });

      // Second request: fallback blocks (bucket full).
      const result2 = await rateLimit(request, options);
      assert.equal(result2.allowed, false);
    } finally {
      console.error = origConsoleError;
    }
  });

  it("keeps the fallback warm before Redis becomes unavailable", async () => {
    const request = makeRequest("10.0.0.62");
    const options = { windowMs: 60_000, maxRequests: 2, keyPrefix: "warm-fallback" };

    assert.deepStrictEqual(await rateLimit(request, options), { allowed: true });
    assert.deepStrictEqual(await rateLimit(request, options), { allowed: true });

    fakeRedis.status = "end";
    const result = await rateLimit(request, options);

    assert.equal(result.allowed, false);
    if (!result.allowed) {
      assert.equal(result.response.status, 429);
    }
  });

  it("warns again when Redis recovers and a later degradation begins", async () => {
    const originalEval = fakeRedis.eval.bind(fakeRedis);
    let shouldFail = true;
    fakeRedis.eval = async (...args: Parameters<FakeRedisClient["eval"]>) => {
      if (shouldFail) throw new Error("Redis unavailable");
      return originalEval(...args);
    };

    const request = makeRequest("10.0.0.63");
    const options = { windowMs: 60_000, maxRequests: 10, keyPrefix: "warning-transition" };
    const originalWarn = console.warn;
    const originalError = console.error;
    const warnings: unknown[][] = [];
    const errors: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    console.error = (...args: unknown[]) => errors.push(args);

    try {
      assert.deepStrictEqual(await rateLimit(request, options), { allowed: true });
      assert.deepStrictEqual(await rateLimit(request, options), { allowed: true });
      assert.equal(warnings.length, 1);
      assert.equal(errors.length, 1);

      shouldFail = false;
      assert.deepStrictEqual(await rateLimit(request, options), { allowed: true });

      shouldFail = true;
      assert.deepStrictEqual(await rateLimit(request, options), { allowed: true });
      assert.equal(warnings.length, 2);
      assert.equal(errors.length, 2);
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
    }
  });
});

describe("Rate Limiter Fallback (sweep and memory)", () => {
  let previousRedisUrl: string | undefined;

  beforeEach(() => {
    previousRedisUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    _redisTestHooks.reset();
    _fallbackLimiterTestHooks.reset();
    _rateLimitTestHooks.resetDegradationState();
  });

  afterEach(() => {
    _redisTestHooks.reset();
    _fallbackLimiterTestHooks.reset();
    _rateLimitTestHooks.resetDegradationState();
    if (previousRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = previousRedisUrl;
    }
  });

  it("sweeps expired entries after the window passes", async () => {
    // Use a very short window so we can test expiry without real waiting.
    // The sweep interval is 30s, but we can test that check() filters
    // expired timestamps for the current key.
    const request = makeRequest("10.0.0.70");
    const options = { windowMs: 100, maxRequests: 1, keyPrefix: "sweep-test" };

    // Fill the bucket.
    assert.deepStrictEqual(await rateLimit(request, options), { allowed: true });

    // Immediately, second request should be blocked.
    assert.equal((await rateLimit(request, options)).allowed, false);

    // After the window expires (wait 150ms), the entry should be filtered
    // and the request allowed again.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepStrictEqual(await rateLimit(request, options), { allowed: true });
  });

  it("denies unknown keys instead of evicting active buckets at capacity", () => {
    const now = Date.now();

    // Fill with entries using distinct keys.
    for (let i = 0; i < _fallbackLimiterTestHooks.capacity; i++) {
      fallbackLimiter.check(`key-${i}`, 60_000, 100, now + i);
    }
    assert.equal(_fallbackLimiterTestHooks.size, _fallbackLimiterTestHooks.capacity);

    // A new key is denied while every stored bucket is still active.
    assert.equal(
      fallbackLimiter.check("key-new", 60_000, 100, now + 20_000),
      "capacity-saturated"
    );
    assert.equal(_fallbackLimiterTestHooks.size, _fallbackLimiterTestHooks.capacity);

    // The oldest active bucket was not evicted or reset.
    assert.equal(
      fallbackLimiter.check("key-0", 60_000, 1, now + 20_001),
      "limit-exceeded"
    );
  });

  it("applies the current window when a key's configuration changes", () => {
    const now = Date.now();

    assert.equal(
      fallbackLimiter.check("changing-window", 10_000, 1, now),
      "allowed"
    );
    assert.equal(
      fallbackLimiter.check("changing-window", 100, 1, now + 1_000),
      "allowed"
    );
  });

  it("sweeps each entry using that entry's configured window", () => {
    const now = Date.now();

    fallbackLimiter.check("short-window", 1_000, 5, now);
    fallbackLimiter.check("long-window", 60_000, 5, now);
    fallbackLimiter.check("sweep-trigger", 60_000, 5, now + 31_000);

    assert.equal(_fallbackLimiterTestHooks.size, 2);
  });

  it("blocks immediately when maxRequests is zero", () => {
    assert.equal(
      fallbackLimiter.check("zero-limit", 60_000, 0, Date.now()),
      "limit-exceeded"
    );
  });
});
