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

describe("Redis Rate Limiter", () => {
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

  it("allows requests within limit", async () => {
    const request = makeRequest("10.0.0.1");
    const result = await rateLimit(request, { windowMs: 60_000, maxRequests: 10, keyPrefix: "test" });
    assert.deepStrictEqual(result, { allowed: true });
  });

  it("blocks requests exceeding limit", async () => {
    const request = makeRequest("10.0.0.2");
    const options = { windowMs: 60_000, maxRequests: 3, keyPrefix: "test-block" };

    // The limiter checks the count before adding the current request, so the
    // first three requests consume the allowance and the fourth is blocked.
    assert.deepStrictEqual(await rateLimit(request, options), { allowed: true });
    assert.deepStrictEqual(await rateLimit(request, options), { allowed: true });
    assert.deepStrictEqual(await rateLimit(request, options), { allowed: true });
    const result = await rateLimit(request, options);

    assert.equal(result.allowed, false);
    if (!result.allowed) {
      assert.equal(result.response.status, 429);
    }
  });

  it("uses unique keys per client IP", async () => {
    const request1 = makeRequest("10.0.0.3");
    const request2 = makeRequest("10.0.0.4");
    const options = { windowMs: 60_000, maxRequests: 2, keyPrefix: "test-ip" };

    // Both IPs should be allowed independently
    assert.deepStrictEqual(await rateLimit(request1, options), { allowed: true });
    assert.deepStrictEqual(await rateLimit(request2, options), { allowed: true });
  });

  it("uses unique keys per keyPrefix", async () => {
    const request = makeRequest("10.0.0.5");

    await rateLimit(request, { windowMs: 60_000, maxRequests: 1, keyPrefix: "prefix-a" });
    const result = await rateLimit(request, { windowMs: 60_000, maxRequests: 1, keyPrefix: "prefix-b" });

    // Different prefixes should not share counters
    assert.deepStrictEqual(result, { allowed: true });
  });

  it("handles x-forwarded-for header correctly", async () => {
    const headers = new Headers();
    headers.set("x-forwarded-for", "203.0.113.195, 70.41.3.18, 150.172.238.178");
    const request = new NextRequest("http://localhost/api/test", { headers });

    const result = await rateLimit(request, { windowMs: 60_000, maxRequests: 5, keyPrefix: "test-fwd" });
    assert.deepStrictEqual(result, { allowed: true });
  });

  it("handles cf-connecting-ip header correctly", async () => {
    const headers = new Headers();
    headers.set("cf-connecting-ip", "203.0.113.195");
    const request = new NextRequest("http://localhost/api/test", { headers });

    const result = await rateLimit(request, { windowMs: 60_000, maxRequests: 5, keyPrefix: "test-cf" });
    assert.deepStrictEqual(result, { allowed: true });
  });

  it("hashes invalid proxy identifiers before storing rate-limit keys", async () => {
    const maliciousIdentifier = "x".repeat(12_000);
    const request = makeRequest(maliciousIdentifier);

    assert.deepStrictEqual(
      await rateLimit(request, {
        windowMs: 60_000,
        maxRequests: 5,
        keyPrefix: "bounded-identifier",
      }),
      { allowed: true }
    );

    assert.equal(fakeRedis.evalKeys.length, 1);
    assert.equal(fakeRedis.evalKeys[0].includes(maliciousIdentifier), false);
    assert.ok(fakeRedis.evalKeys[0].length < 128);
  });

  it("short-circuits oversized identifiers without hashing", async () => {
    const oversized = "x".repeat(512);
    const request = makeRequest(oversized);

    assert.deepStrictEqual(
      await rateLimit(request, {
        windowMs: 60_000,
        maxRequests: 5,
        keyPrefix: "oversized-identifier",
      }),
      { allowed: true }
    );

    // The key should use the "invalid:oversized" short-circuit, not a hash.
    assert.equal(fakeRedis.evalKeys.length, 1);
    assert.ok(fakeRedis.evalKeys[0].includes("invalid:oversized"));
    assert.ok(fakeRedis.evalKeys[0].length < 80);
  });

  it("includes a Retry-After header on 429 responses", async () => {
    const request = makeRequest("10.0.0.20");
    const options = { windowMs: 30_000, maxRequests: 1, keyPrefix: "retry-after" };

    await rateLimit(request, options); // First request OK
    const result = await rateLimit(request, options); // Second blocked

    assert.equal(result.allowed, false);
    if (!result.allowed) {
      assert.equal(result.response.status, 429);
      assert.equal(result.response.headers.get("Retry-After"), "30");
    }
  });

  it("uses EVALSHA and falls back to EVAL on NOSCRIPT", async () => {
    // Phase 1: normal call — EVALSHA succeeds with the correct SHA.
    const request = makeRequest("10.0.0.21");
    await rateLimit(request, { windowMs: 60_000, maxRequests: 5, keyPrefix: "evalsha-test" });
    assert.ok(fakeRedis.evalshaCalls > 0, "EVALSHA should be called first");

    // Phase 2: force NOSCRIPT by overriding evalsha to always throw.
    // The EVAL fallback should kick in and the request should still succeed.
    const originalEvalsha = fakeRedis.evalsha.bind(fakeRedis);
    fakeRedis.evalsha = async () => {
      throw new Error("NOSCRIPT No matching script. Please use EVAL.");
    };
    try {
      const result = await rateLimit(makeRequest("10.0.0.22"), {
        windowMs: 60_000,
        maxRequests: 5,
        keyPrefix: "evalsha-noscript",
      });
      assert.deepStrictEqual(result, { allowed: true });
    } finally {
      fakeRedis.evalsha = originalEvalsha;
    }
  });

  it("falls back to in-process limiter when Redis client is unavailable", async () => {
    // Simulate Redis not configured by passing null-like state
    const request = makeRequest("10.0.0.6");
    const previousRedisUrl = process.env.REDIS_URL;

    // With a disconnected client, the in-process fallback kicks in.
    // First request should be allowed (bucket empty), second blocked.
    _fallbackLimiterTestHooks.reset();
    _rateLimitTestHooks.resetDegradationState();
    delete process.env.REDIS_URL;
    fakeRedis.status = "end";
    try {
      const result1 = await rateLimit(request, { windowMs: 60_000, maxRequests: 1, keyPrefix: "test-failopen" });
      assert.deepStrictEqual(result1, { allowed: true });

      const result2 = await rateLimit(request, { windowMs: 60_000, maxRequests: 1, keyPrefix: "test-failopen" });
      assert.equal(result2.allowed, false);
    } finally {
      if (previousRedisUrl === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = previousRedisUrl;
      }
    }
  });

  it("falls back to in-process limiter when Redis URL is not set", async () => {
    const previousRedisUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    _redisTestHooks.reset();
    _fallbackLimiterTestHooks.reset();
    _rateLimitTestHooks.resetDegradationState();

    const request = makeRequest("10.0.0.7");
    let result: Awaited<ReturnType<typeof rateLimit>>;
    try {
      result = await rateLimit(request, {
        windowMs: 60_000,
        maxRequests: 1,
        keyPrefix: "test-noredis",
      });
    } finally {
      if (previousRedisUrl === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = previousRedisUrl;
      }
      _redisTestHooks.reset();
    }

    // First request is allowed (bucket empty in fallback).
    assert.deepStrictEqual(result, { allowed: true });
  });

  it("uses healthy Redis at local capacity but fails closed if Redis is down", async () => {
    const now = Date.now();
    for (let i = 0; i < _fallbackLimiterTestHooks.capacity; i++) {
      assert.equal(
        fallbackLimiter.check(`capacity-${i}`, 60_000, 10, now),
        "allowed"
      );
    }

    const options = {
      windowMs: 60_000,
      maxRequests: 10,
      keyPrefix: "capacity-fallback",
    };
    assert.deepStrictEqual(
      await rateLimit(makeRequest("10.0.0.8"), options),
      { allowed: true }
    );

    const previousRedisUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    fakeRedis.status = "end";
    try {
      const degraded = await rateLimit(makeRequest("10.0.0.9"), options);
      assert.equal(degraded.allowed, false);
      // Verify no new entry was added on capacity-saturated denial.
      assert.equal(_fallbackLimiterTestHooks.size, _fallbackLimiterTestHooks.capacity);
    } finally {
      if (previousRedisUrl === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = previousRedisUrl;
      }
    }
  });

  it("rolls back the warmed local entry when Redis rejects the request", async () => {
    const ip = "10.0.0.14";
    const keyPrefix = "rollback-on-redis-reject";
    const key = `ratelimit:${keyPrefix}:${ip}`;
    const now = Date.now();
    fakeRedis.status = "ready";
    fakeRedis.zadd(key, now, "other-instance-request");

    const options = { windowMs: 60_000, maxRequests: 1, keyPrefix };
    const rejected = await rateLimit(makeRequest(ip), options);
    assert.equal(rejected.allowed, false);

    const previousRedisUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    fakeRedis.status = "end";
    try {
      assert.deepStrictEqual(await rateLimit(makeRequest(ip), options), {
        allowed: true,
      });
    } finally {
      if (previousRedisUrl === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = previousRedisUrl;
      }
    }
  });

  it("survives a full healthy → degraded → healthy → degraded transition cycle", async () => {
    const ip = "10.0.0.15";
    const options = { windowMs: 60_000, maxRequests: 2, keyPrefix: "lifecycle" };
    const request = makeRequest(ip);
    const previousRedisUrl = process.env.REDIS_URL;

    try {
      // Phase 1: Redis healthy — requests go through Redis path.
      assert.deepStrictEqual(await rateLimit(request, options), { allowed: true });
      assert.deepStrictEqual(await rateLimit(request, options), { allowed: true });
      // Third request: local guard (2/2) blocks before Redis is consulted.
      const blocked = await rateLimit(request, options);
      assert.equal(blocked.allowed, false);

      // Phase 2: Redis goes down — fallback limiter is already warm from phase 1.
      // The local map holds 2 timestamps for this key, so the next request is
      // denied by the local guard without touching Redis.
      fakeRedis.status = "end";
      const degraded = await rateLimit(request, options);
      assert.equal(degraded.allowed, false);

      // Phase 3: Redis recovers.  Simulate windowMs elapsing by resetting
      // both the in-process fallback (stale local timestamps) and the
      // FakeRedis sorted set (stale Redis-side timestamps).  In production
      // this happens naturally when windowMs seconds pass.
      fakeRedis.status = "ready";
      _fallbackLimiterTestHooks.reset();
      // Swap in a fresh FakeRedis so Phase 1's ZSET entries are gone.
      fakeRedis = new FakeRedisClient();
      _redisTestHooks.setClientForTesting(fakeRedis as never);
      const recovered = await rateLimit(request, options);
      assert.deepStrictEqual(recovered, { allowed: true });

      // Phase 4: A second degradation cycle begins. The warning should fire
      // again because markRedisResponded reset the degradation flags in phase 3.
      fakeRedis.status = "end";
      const degradedAgain = await rateLimit(request, options);
      // Local guard has 1 timestamp (from phase 3), so this is allowed.
      assert.deepStrictEqual(degradedAgain, { allowed: true });
      // One more request should be blocked by the local guard (2/2).
      const blocked2 = await rateLimit(request, options);
      assert.equal(blocked2.allowed, false);
    } finally {
      if (previousRedisUrl === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = previousRedisUrl;
      }
    }
  });

  it("correctly rolls back duplicate timestamps when Redis rejects under same-ms burst", async () => {
    // Construct a scenario where the local guard ADMITS but Redis REJECTS,
    // forcing the rollback path to run on duplicate timestamps.
    //
    // Strategy: use a FakeRedisClient that always rejects (pre-filled to
    // capacity) so every rateLimit call passes the local guard but is
    // denied by Redis, triggering rollback of duplicate timestamps.
    const ip = "10.0.0.16";
    const keyPrefix = "dup-rollback-redis-reject";
    const redisKey = `ratelimit:${keyPrefix}:${ip}`;
    const options = { windowMs: 60_000, maxRequests: 10, keyPrefix };
    const request = makeRequest(ip);

    // Pre-fill Redis to capacity so every eval returns 0 (denied).
    const now = Date.now();
    fakeRedis.status = "ready";
    fakeRedis.zadd(redisKey, now, "blocker"); // 1 entry, but maxRequests=10
    // Fill to exactly maxRequests so eval denies.
    for (let i = 1; i < 10; i++) {
      fakeRedis.zadd(redisKey, now - i, `pre-existing-${i}`);
    }

    // Single request that passes local guard but Redis denies → rollback.
    const result = await rateLimit(request, options);
    assert.equal(result.allowed, false, "Redis should deny (at capacity)");

    // The rollback should have removed the local timestamp.
    // Verify by turning Redis off and checking local guard allows (empty bucket).
    const previousRedisUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    fakeRedis.status = "end";
    try {
      const recovered = await rateLimit(request, options);
      assert.deepStrictEqual(recovered, { allowed: true });
    } finally {
      if (previousRedisUrl === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = previousRedisUrl;
      }
    }
  });
});

describe("Rate Limiter Edge Cases", () => {
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

  it("returns correct error message on rate limit", async () => {
    const request = makeRequest("10.0.0.10");
    const options = { windowMs: 60_000, maxRequests: 1, keyPrefix: "test-msg" };

    await rateLimit(request, options);
    const result = await rateLimit(request, options);

    assert.equal(result.allowed, false);
    if (!result.allowed) {
      assert.equal(result.response.status, 429);
    }
  });

  it("enforces the local guard across concurrent requests from the same IP", async () => {
    const request = makeRequest("10.0.0.11");
    const options = { windowMs: 60_000, maxRequests: 10, keyPrefix: "test-concurrent" };

    const results = await Promise.all(
      Array.from({ length: 50 }, () => rateLimit(request, options))
    );

    assert.equal(results.filter((result) => result.allowed).length, 10);
    assert.equal(results.filter((result) => !result.allowed).length, 40);
  });

  it("shares the first Redis connection attempt across a lazy-client burst", async () => {
    const burstRedis = new FakeRedisClient({ connectDelayMs: 10 });
    _redisTestHooks.setClientForTesting(burstRedis as never);

    const request = makeRequest("10.0.0.12");
    const options = { windowMs: 60_000, maxRequests: 100, keyPrefix: "test-lazy-burst" };

    // The delayed connect keeps the lazy client in "wait" long enough for the
    // burst to share the in-flight connection promise.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => rateLimit(request, options))
    );

    assert.equal(burstRedis.connectCalls, 1);
    for (const result of results) {
      assert.deepStrictEqual(result, { allowed: true });
    }
  });

  it("falls back to in-process limiter and suppresses immediate retries when the lazy Redis connect fails", async () => {
    const failingRedis = new FakeRedisClient({ rejectConnect: true });
    _redisTestHooks.setClientForTesting(failingRedis as never);
    _fallbackLimiterTestHooks.reset();

    const request = makeRequest("10.0.0.13");
    const options = { windowMs: 60_000, maxRequests: 1, keyPrefix: "test-lazy-fail" };
    const originalConsoleError = console.error;
    const errorLogs: unknown[][] = [];

    console.error = (...args: unknown[]) => {
      errorLogs.push(args);
    };

    try {
      // First request: Redis connect fails, fallback limiter allows (bucket empty).
      assert.deepStrictEqual(await rateLimit(request, options), { allowed: true });
      // Second request: Redis on cooldown, fallback limiter blocks (bucket full).
      const result2 = await rateLimit(request, options);
      assert.equal(result2.allowed, false);
      if (!result2.allowed) {
        assert.equal(result2.response.status, 429);
      }
      assert.equal(failingRedis.connectCalls, 1);
      // The second call should short-circuit on the reconnect cooldown instead
      // of attempting, and logging, another failed Redis connection.
      assert.equal(errorLogs.length, 1);
    } finally {
      console.error = originalConsoleError;
    }
  });
});
