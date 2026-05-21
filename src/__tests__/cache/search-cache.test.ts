import { describe, it } from "node:test";
import {
  buildSearchCacheKey,
  getCachedSearchResults,
  invalidateSearchCache,
  setCachedSearchResults,
} from "@/lib/cache/search-cache";
import { getRedisClient, _redisTestHooks } from "@/lib/cache/redis";
import type { MemoryResult } from "@/lib/memory/types";
import assert from "assert";

class FakeRedisClient {
  status = "wait";
  private readonly store = new Map<string, string>();

  async connect() {
    this.status = "ready";
  }

  disconnect() {
    this.status = "end";
  }

  async get(key: string) {
    this.assertReady();
    return this.store.get(key) ?? null;
  }

  async setex(key: string, _ttlSeconds: number, value: string) {
    this.assertReady();
    this.store.set(key, value);
    return "OK";
  }

  async incr(key: string) {
    this.assertReady();
    const value = Number(this.store.get(key) ?? "0") + 1;
    this.store.set(key, String(value));
    return value;
  }

  private assertReady() {
    if (this.status !== "ready") {
      throw new Error("Redis command executed before client was ready");
    }
  }
}

const cachedResult: MemoryResult = {
  id: "article-1",
  provider: "noosphere",
  sourceType: "noosphere",
  title: "Cached Article",
  content: "Cached content",
  metadata: {},
};

describe("Search Cache Key Generation", () => {
  it("should normalize queries case-insensitively and trim spaces", () => {
    const key1 = buildSearchCacheKey({ query: "  Test QUERY   " });
    const key2 = buildSearchCacheKey({ query: "test query" });
    assert.strictEqual(key1, key2);
  });

  it("should prevent limit:undefined and limit:0 collisions", () => {
    const keyUndefined = buildSearchCacheKey({ query: "test", limit: undefined });
    const keyZero = buildSearchCacheKey({ query: "test", limit: 0 });
    assert.notStrictEqual(keyUndefined, keyZero);
  });

  it("should prevent in-place allowedScopes mutation", () => {
    const originalScopes = ["beta", "alpha"];
    buildSearchCacheKey({ query: "test", allowedScopes: originalScopes });
    // Verify that the original array is NOT mutated (mutating it would make it ["alpha", "beta"])
    assert.deepStrictEqual(originalScopes, ["beta", "alpha"]);
  });
});

describe("Search Cache Redis Operations", () => {
  it("discards terminal Redis clients before future cache lookups", () => {
    const previousRedisUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    const redis = new FakeRedisClient();
    redis.status = "close";
    _redisTestHooks.setClientForTesting(redis as never);

    try {
      assert.strictEqual(getRedisClient(), null);
      assert.strictEqual(redis.status, "end");
    } finally {
      if (previousRedisUrl === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = previousRedisUrl;
      }
      _redisTestHooks.reset();
    }
  });

  it("connects a lazy Redis client before executing cache commands", async () => {
    const redis = new FakeRedisClient();
    _redisTestHooks.setClientForTesting(redis as never);

    try {
      const cacheKey = buildSearchCacheKey({ query: "lazy redis" });

      await setCachedSearchResults(cacheKey, [cachedResult]);
      const cached = await getCachedSearchResults(cacheKey);

      assert.strictEqual(redis.status, "ready");
      assert.deepStrictEqual(cached, [cachedResult]);
    } finally {
      _redisTestHooks.reset();
    }
  });

  it("does not write stale search results when the invalidation version changed", async () => {
    const redis = new FakeRedisClient();
    _redisTestHooks.setClientForTesting(redis as never);

    try {
      const cacheKey = buildSearchCacheKey({ query: "stale race", cacheVersion: "0" });

      await invalidateSearchCache();
      await setCachedSearchResults(cacheKey, [cachedResult], "0");

      assert.strictEqual(await getCachedSearchResults(cacheKey), null);
    } finally {
      _redisTestHooks.reset();
    }
  });
});
