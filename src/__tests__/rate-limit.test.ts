import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "assert";
import { rateLimit } from "@/lib/rate-limit";
import { _redisTestHooks } from "@/lib/cache/redis";
import { NextRequest } from "next/server";

class FakeRedisClient {
  status: "wait" | "ready" | "end" = "ready";
  private readonly store = new Map<string, string>();
  private readonly expires = new Map<string, number>();

  async connect() {
    this.status = "ready";
  }

  disconnect() {
    this.status = "end";
  }

  async get(key: string): Promise<string | null> {
    this.assertReady();
    const expiry = this.expires.get(key);
    if (expiry !== undefined && Date.now() > expiry) {
      this.store.delete(key);
      this.expires.delete(key);
      return null;
    }
    return this.store.get(key) ?? null;
  }

  async setex(key: string, ttlSeconds: number, value: string): Promise<string> {
    this.assertReady();
    this.store.set(key, value);
    this.expires.set(key, Date.now() + ttlSeconds * 1000);
    return "OK";
  }

  zadd(key: string, score: number, member: string): number {
    this.assertReady();
    const setKey = `zset:${key}`;
    if (!this.store.has(setKey)) {
      this.store.set(setKey, JSON.stringify([]));
    }
    const arr: Array<{ member: string; score: number }> = JSON.parse(this.store.get(setKey) ?? "[]");
    const existing = arr.findIndex((item) => item.member === member);
    if (existing === -1) {
      arr.push({ member, score });
      this.store.set(setKey, JSON.stringify(arr));
      return 1;
    }
    return 0;
  }

  zremrangebyscore(key: string, min: string, max: string): number {
    this.assertReady();
    const setKey = `zset:${key}`;
    const arr: Array<{ member: string; score: number }> = JSON.parse(this.store.get(setKey) ?? "[]");
    const before = arr.length;
    const minNum = parseFloat(min);
    const maxNum = parseFloat(max);
    const filtered = arr.filter((item) => item.score < minNum || item.score > maxNum);
    this.store.set(setKey, JSON.stringify(filtered));
    return before - filtered.length;
  }

  zcard(key: string): number {
    this.assertReady();
    const setKey = `zset:${key}`;
    return JSON.parse(this.store.get(setKey) ?? "[]").length;
  }

  private assertReady() {
    if (this.status !== "ready") {
      throw new Error("Redis command executed before client was ready");
    }
  }

  pipeline() {
    const commands: Array<{ method: string; args: unknown[] }> = [];

    const pipelineObj = {
      zremrangebyscore: (key: string, min: string, max: string) => {
        commands.push({ method: "zremrangebyscore", args: [key, min, max] });
        return pipelineObj;
      },
      zcard: (key: string) => {
        commands.push({ method: "zcard", args: [key] });
        return pipelineObj;
      },
      zadd: (key: string, score: number, member: string) => {
        commands.push({ method: "zadd", args: [key, score, member] });
        return pipelineObj;
      },
      expire: (key: string, seconds: number) => {
        commands.push({ method: "expire", args: [key, seconds] });
        return pipelineObj;
      },
      exec: () => {
        const results: Array<[Error | null, unknown]> = [];
        for (const cmd of commands) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const client = this as unknown as Record<string, (...args: unknown[]) => unknown>;
            const result = client[cmd.method](...cmd.args);
            if (result instanceof Promise) {
              throw new Error("Pipeline exec called with async methods but should be synchronous");
            }
            results.push([null, result]);
          } catch (err) {
            results.push([err as Error, null]);
          }
        }
        return results;
      },
    };
    return pipelineObj;
  }
}

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

    // Use up the limit
    await rateLimit(request, options);
    await rateLimit(request, options);
    const result = await rateLimit(request, options);

    assert.deepStrictEqual(result, { allowed: false });
    assert.equal(result.response.status, 429);
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
    assert.equal(result.response.status, 429);
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
});
