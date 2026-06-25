import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "assert";
import { rateLimit } from "@/lib/rate-limit";
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
  });

  afterEach(() => {
    _redisTestHooks.reset();
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

  it("falls back to allowing when Redis client is unavailable", async () => {
    // Simulate Redis not configured by passing null-like state
    const request = makeRequest("10.0.0.6");

    // With a disconnected client, should fail open (allow)
    fakeRedis.status = "end";
    const result = await rateLimit(request, { windowMs: 60_000, maxRequests: 1, keyPrefix: "test-failopen" });
    assert.deepStrictEqual(result, { allowed: true });
  });

  it("falls back to allowing when Redis URL is not set", async () => {
    const previousRedisUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    _redisTestHooks.reset();

    const request = makeRequest("10.0.0.7");
    const result = await rateLimit(request, { windowMs: 60_000, maxRequests: 1, keyPrefix: "test-noredis" });

    if (previousRedisUrl !== undefined) {
      process.env.REDIS_URL = previousRedisUrl;
    }
    _redisTestHooks.reset();

    assert.deepStrictEqual(result, { allowed: true });
  });
});

describe("Rate Limiter Edge Cases", () => {
  let fakeRedis: FakeRedisClient;

  beforeEach(() => {
    fakeRedis = new FakeRedisClient();
    _redisTestHooks.setClientForTesting(fakeRedis as never);
  });

  afterEach(() => {
    _redisTestHooks.reset();
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

  it("handles concurrent requests from same IP", async () => {
    const request = makeRequest("10.0.0.11");
    const options = { windowMs: 60_000, maxRequests: 100, keyPrefix: "test-concurrent" };

    // Simulate burst of requests
    for (let i = 0; i < 50; i++) {
      const result = await rateLimit(request, options);
      assert.equal(result.allowed, true);
    }
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

  it("falls open and suppresses immediate retries when the lazy Redis connect fails", async () => {
    const failingRedis = new FakeRedisClient({ rejectConnect: true });
    _redisTestHooks.setClientForTesting(failingRedis as never);

    const request = makeRequest("10.0.0.13");
    const options = { windowMs: 60_000, maxRequests: 1, keyPrefix: "test-lazy-fail" };
    const originalConsoleError = console.error;
    const errorLogs: unknown[][] = [];

    console.error = (...args: unknown[]) => {
      errorLogs.push(args);
    };

    try {
      assert.deepStrictEqual(await rateLimit(request, options), { allowed: true });
      assert.deepStrictEqual(await rateLimit(request, options), { allowed: true });
      assert.equal(failingRedis.connectCalls, 1);
      // The second call should short-circuit on the reconnect cooldown instead
      // of attempting, and logging, another failed Redis connection.
      assert.equal(errorLogs.length, 1);
    } finally {
      console.error = originalConsoleError;
    }
  });
});
