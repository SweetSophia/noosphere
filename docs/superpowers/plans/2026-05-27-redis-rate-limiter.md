# Redis-Backed Rate Limiter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the in-memory `Map`-based rate limiter with a Redis-backed sliding window implementation to prevent bypass in horizontally scaled deployments.

**Architecture:** Implement a sliding window rate limiter using Redis sorted sets. The window slides continuously rather than using fixed buckets, providing smoother rate limiting. Falls back to in-memory behavior if Redis is unavailable (fail-open), maintaining backward compatibility.

**Tech Stack:** ioredis (existing), TypeScript

---

## File Structure

- **Create:** `src/lib/rate-limit.ts` — New Redis-backed rate limiter (replaces existing)
- **Create:** `src/__tests__/rate-limit.test.ts` — Comprehensive tests
- **Modify:** `src/__tests__/security/proxy.test.ts` — Update to mock Redis for tests

## Pre-Implementation Context

### Current Rate Limiter (src/lib/rate-limit.ts)
- Uses `new Map<string, RateLimitEntry>()` per-process in-memory store
- Fixed-window algorithm with per-minute cleanup
- Returns `{ allowed: true }` or `{ allowed: false; response: NextResponse }`

### Existing Redis Client (src/lib/cache/redis.ts)
- `getRedisClient()` returns `Redis | null` (fail-open)
- `_redisTestHooks.setClientForTesting(client)` for testing injection
- `_redisTestHooks.reset()` to restore production client

### Testing Pattern (from src/__tests__/cache/search-cache.test.ts)
- Uses `FakeRedisClient` class implementing minimal Redis interface
- Injects via `_redisTestHooks.setClientForTesting(redis as never)`
- Cleans up via `_redisTestHooks.reset()` in finally block

---

## Task 1: Write Redis Rate Limiter Tests

**Files:**
- Create: `src/__tests__/rate-limit.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "assert";
import { rateLimit } from "@/lib/rate-limit";
import { _redisTestHooks } from "@/lib/cache/redis";
import { NextRequest } from "next/server";

class FakeRedisClient {
  status = "wait";
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

  async zadd(key: string, _score: number, member: string): Promise<number> {
    this.assertReady();
    const setKey = `zset:${key}`;
    if (!this.store.has(setKey)) {
      this.store.set(setKey, JSON.stringify([]));
    }
    const arr: string[] = JSON.parse(this.store.get(setKey) ?? "[]");
    if (!arr.includes(member)) {
      arr.push(member);
      this.store.set(setKey, JSON.stringify(arr));
      return 1;
    }
    return 0;
  }

  async zremrangebyscore(key: string, min: string, max: string): Promise<number> {
    this.assertReady();
    const setKey = `zset:${key}`;
    const arr: string[] = JSON.parse(this.store.get(setKey) ?? "[]");
    const before = arr.length;
    const minNum = parseFloat(min);
    const maxNum = parseFloat(max);
    const filtered = arr.filter((item) => {
      const timestamp = parseFloat(item.split(":")[1] ?? "0");
      return timestamp < minNum || timestamp > maxNum;
    });
    this.store.set(setKey, JSON.stringify(filtered));
    return before - filtered.length;
  }

  async zcard(key: string): Promise<number> {
    this.assertReady();
    const setKey = `zset:${key}`;
    return JSON.parse(this.store.get(setKey) ?? "[]").length;
  }

  private assertReady() {
    if (this.status !== "ready") {
      throw new Error("Redis command executed before client was ready");
    }
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

  it("allows requests within limit", () => {
    const request = makeRequest("10.0.0.1");
    const result = rateLimit(request, { windowMs: 60_000, maxRequests: 10, keyPrefix: "test" });
    assert.deepStrictEqual(result, { allowed: true });
  });

  it("blocks requests exceeding limit", () => {
    const request = makeRequest("10.0.0.2");
    const options = { windowMs: 60_000, maxRequests: 3, keyPrefix: "test-block" };

    // Use up the limit
    rateLimit(request, options);
    rateLimit(request, options);
    const result = rateLimit(request, options);

    assert.deepStrictEqual(result, { allowed: false });
    assert.equal(result.response.status, 429);
  });

  it("uses unique keys per client IP", () => {
    const request1 = makeRequest("10.0.0.3");
    const request2 = makeRequest("10.0.0.4");
    const options = { windowMs: 60_000, maxRequests: 2, keyPrefix: "test-ip" };

    // Both IPs should be allowed independently
    assert.deepStrictEqual(rateLimit(request1, options), { allowed: true });
    assert.deepStrictEqual(rateLimit(request2, options), { allowed: true });
  });

  it("uses unique keys per keyPrefix", () => {
    const request = makeRequest("10.0.0.5");
    
    rateLimit(request, { windowMs: 60_000, maxRequests: 1, keyPrefix: "prefix-a" });
    const result = rateLimit(request, { windowMs: 60_000, maxRequests: 1, keyPrefix: "prefix-b" });

    // Different prefixes should not share counters
    assert.deepStrictEqual(result, { allowed: true });
  });

  it("handles x-forwarded-for header correctly", () => {
    const headers = new Headers();
    headers.set("x-forwarded-for", "203.0.113.195, 70.41.3.18, 150.172.238.178");
    const request = new NextRequest("http://localhost/api/test", { headers });
    
    const result = rateLimit(request, { windowMs: 60_000, maxRequests: 5, keyPrefix: "test-fwd" });
    assert.deepStrictEqual(result, { allowed: true });
  });

  it("handles cf-connecting-ip header correctly", () => {
    const headers = new Headers();
    headers.set("cf-connecting-ip", "203.0.113.195");
    const request = new NextRequest("http://localhost/api/test", { headers });
    
    const result = rateLimit(request, { windowMs: 60_000, maxRequests: 5, keyPrefix: "test-cf" });
    assert.deepStrictEqual(result, { allowed: true });
  });

  it("falls back to allowing when Redis client is unavailable", () => {
    // Simulate Redis not configured by passing null-like state
    const request = makeRequest("10.0.0.6");
    
    // With a disconnected client, should fail open (allow)
    fakeRedis.status = "end";
    const result = rateLimit(request, { windowMs: 60_000, maxRequests: 1, keyPrefix: "test-failopen" });
    assert.deepStrictEqual(result, { allowed: true });
  });

  it("falls back to allowing when Redis URL is not set", () => {
    const previousRedisUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    _redisTestHooks.reset();

    const request = makeRequest("10.0.0.7");
    const result = rateLimit(request, { windowMs: 60_000, maxRequests: 1, keyPrefix: "test-noredis" });
    
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

  it("returns correct error message on rate limit", () => {
    const request = makeRequest("10.0.0.10");
    const options = { windowMs: 60_000, maxRequests: 1, keyPrefix: "test-msg" };

    rateLimit(request, options);
    const result = rateLimit(request, options);

    assert.equal(result.allowed, false);
    assert.equal(result.response.status, 429);
  });

  it("handles concurrent requests from same IP", () => {
    const request = makeRequest("10.0.0.11");
    const options = { windowMs: 60_000, maxRequests: 100, keyPrefix: "test-concurrent" };

    // Simulate burst of requests
    for (let i = 0; i < 50; i++) {
      const result = rateLimit(request, options);
      assert.equal(result.allowed, true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/__tests__/rate-limit.test.ts`
Expected: FAIL with "Module not found" or import errors (rate-limit.ts hasn't been updated yet)

---

## Task 2: Implement Redis-Backed Rate Limiter

**Files:**
- Modify: `src/lib/rate-limit.ts` (entire file rewrite)

- [ ] **Step 1: Write the Redis-backed rate limiter**

Replace the entire contents of `src/lib/rate-limit.ts` with:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { getRedisClient } from "@/lib/cache/redis";

interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  keyPrefix?: string;
}

function getClientIdentifier(request: NextRequest): string {
  // NextRequest no longer exposes a typed `ip` property in this Next.js version.
  // In production, these headers must be set/sanitized by the trusted reverse
  // proxy/CDN; direct client-supplied forwarding headers are not trustworthy.
  return (
    request.headers.get("x-real-ip") ??
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

/**
 * Sliding window rate limiter using Redis sorted sets.
 * 
 * Algorithm:
 * 1. Use a sorted set with member = timestamp:random to handle ties
 * 2. Remove entries outside the window
 * 3. Count remaining entries
 * 4. If under limit, add new entry and allow
 * 5. If at/over limit, deny
 * 
 * Falls back to fail-open (allow) if Redis is unavailable.
 */
export function rateLimit(
  request: NextRequest,
  options: RateLimitOptions
): { allowed: true } | { allowed: false; response: NextResponse } {
  const clientId = getClientIdentifier(request);
  const key = `ratelimit:${options.keyPrefix ?? "default"}:${clientId}`;
  const now = Date.now();
  const windowStart = now - options.windowMs;

  const redis = getRedisClient();

  // Fail-open: if Redis is not available, allow the request
  if (!redis) {
    return { allowed: true };
  }

  try {
    // Use a pipeline for atomic operations
    const pipeline = redis.pipeline();

    // Remove expired entries (outside the window)
    pipeline.zremrangebyscore(key, "-inf", windowStart.toString());

    // Count current entries in window
    pipeline.zcard(key);

    // Add new entry with current timestamp as score
    // Use timestamp:randomUUID for unique member (handles multiple requests at same ms)
    const member = `${now}:${crypto.randomUUID()}`;
    pipeline.zadd(key, now, member);

    // Set expiry on the key to auto-cleanup
    pipeline.expire(key, Math.ceil(options.windowMs / 1000) + 1);

    const results = pipeline.exec();

    if (!results) {
      // Pipeline execution failed
      return { allowed: true };
    }

    // results[1] is the zcard result: [error, count]
    const countResult = results[1];
    if (countResult[0]) {
      // Error in count operation
      return { allowed: true };
    }

    const currentCount = countResult[1] as number;

    if (currentCount >= options.maxRequests) {
      return {
        allowed: false,
        response: apiError("Too many requests", 429),
      };
    }

    return { allowed: true };
  } catch (error) {
    // Unexpected error - fail open
    console.error("Rate limiter error:", error);
    return { allowed: true };
  }
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `node --import tsx --test src/__tests__/rate-limit.test.ts`
Expected: PASS

---

## Task 3: Update Proxy Security Tests

**Files:**
- Modify: `src/__tests__/security/proxy.test.ts`

The proxy tests currently rely on the in-memory store maintaining state between calls. With Redis-backed rate limiting, each test's requests need to share a Redis instance. The `FakeRedisClient` in each test file is isolated, so we need to ensure the proxy middleware uses the injected Redis client.

- [ ] **Step 1: Add Redis test hooks to proxy tests**

Add the following import and setup to `src/__tests__/security/proxy.test.ts`:

```typescript
import { _redisTestHooks } from "@/lib/cache/redis";
```

Add a `FakeRedisClient` class (same as in rate-limit.test.ts) and setup/teardown:

```typescript
class FakeRedisClient {
  status = "wait";
  private readonly store = new Map<string, string>();
  private readonly expires = new Map<string, number>();

  async connect() { this.status = "ready"; }
  disconnect() { this.status = "end"; }

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

  async zadd(key: string, _score: number, member: string): Promise<number> {
    this.assertReady();
    const setKey = `zset:${key}`;
    if (!this.store.has(setKey)) {
      this.store.set(setKey, JSON.stringify([]));
    }
    const arr: string[] = JSON.parse(this.store.get(setKey) ?? "[]");
    if (!arr.includes(member)) {
      arr.push(member);
      this.store.set(setKey, JSON.stringify(arr));
      return 1;
    }
    return 0;
  }

  async zremrangebyscore(key: string, min: string, max: string): Promise<number> {
    this.assertReady();
    const setKey = `zset:${key}`;
    const arr: string[] = JSON.parse(this.store.get(setKey) ?? "[]");
    const before = arr.length;
    const minNum = parseFloat(min);
    const maxNum = parseFloat(max);
    const filtered = arr.filter((item) => {
      const timestamp = parseFloat(item.split(":")[1] ?? "0");
      return timestamp < minNum || timestamp > maxNum;
    });
    this.store.set(setKey, JSON.stringify(filtered));
    return before - filtered.length;
  }

  async zcard(key: string): Promise<number> {
    this.assertReady();
    const setKey = `zset:${key}`;
    return JSON.parse(this.store.get(setKey) ?? "[]").length;
  }

  async expire(key: string, _seconds: number): Promise<number> {
    this.assertReady();
    return 1;
  }

  pipeline() {
    const commands: Array<() => Promise<unknown>> = [];
    const self = this;
    return {
      zremrangebyscore(key: string, min: string, max: string) {
        commands.push(() => self.zremrangebyscore(key, min, max));
        return this;
      },
      zcard(key: string) {
        commands.push(() => self.zcard(key));
        return this;
      },
      zadd(key: string, score: number, member: string) {
        commands.push(() => self.zadd(key, score, member));
        return this;
      },
      expire(key: string, seconds: number) {
        commands.push(() => self.expire(key, seconds));
        return this;
      },
      exec() {
        return Promise.resolve(
          commands.map((cmd) => [null, cmd()])
        );
      },
    };
  }

  private assertReady() {
    if (this.status !== "ready") {
      throw new Error("Redis command executed before client was ready");
    }
  }
}
```

Add setup and teardown to each test that uses rate limiting:

```typescript
test("proxy rate-limits article mutation routes", async () => {
  const fakeRedis = new FakeRedisClient();
  fakeRedis.status = "ready";
  _redisTestHooks.setClientForTesting(fakeRedis as never);

  try {
    const headers = { "x-real-ip": `patch-${crypto.randomUUID()}` };
    let response = await proxy(request("/api/articles/article-1", { method: "PATCH", headers }));

    for (let i = 1; i < 30; i += 1) {
      response = await proxy(request("/api/articles/article-1", { method: "PATCH", headers }));
    }

    assert.notEqual(response.status, 429);

    const blocked = await proxy(request("/api/articles/article-1", { method: "PATCH", headers }));
    assert.equal(blocked.status, 429);
  } finally {
    _redisTestHooks.reset();
  }
});
```

Apply the same pattern to the "proxy does not rate-limit article reads" test (which should NOT be rate-limited, but still needs proper Redis setup for consistency).

- [ ] **Step 2: Run security tests to verify they pass**

Run: `npm run test:security`
Expected: PASS

---

## Task 4: Run Full Test Suite

**Files:** None (verification only)

- [ ] **Step 1: Run all tests**

Run: `npm run test`
Expected: All test suites pass

- [ ] **Step 2: Verify linting**

Run: `npm run lint`
Expected: No errors

---

## Task 5: Commit Changes

- [ ] **Step 1: Stage and commit**

```bash
git add src/lib/rate-limit.ts src/__tests__/rate-limit.test.ts src/__tests__/security/proxy.test.ts
git commit -m "feat(security): replace in-memory rate limiter with Redis-backed sliding window

- Prevents rate limit bypass in horizontally scaled deployments
- Uses Redis sorted sets for accurate sliding window algorithm
- Falls back to fail-open if Redis is unavailable
- Maintains same API signature for backward compatibility

Fixes #130"
```

---

## Self-Review Checklist

- [x] Spec coverage: Issue #130 validity confirmed ✓
- [x] No placeholders in plan ✓
- [x] Type consistency: `rateLimit()` signature unchanged ✓
- [x] Fail-open behavior documented ✓
- [x] Test coverage for edge cases ✓
- [x] Backward compatibility maintained ✓
