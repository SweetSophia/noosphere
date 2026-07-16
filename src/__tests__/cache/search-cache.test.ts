import { describe, it } from "node:test";
import {
  buildSearchCacheKey,
  getCachedSearchResults,
  getSearchCacheVersion,
  invalidateSearchCache,
  setCachedSearchResults,
} from "@/lib/cache/search-cache";
import { getRedisClient, _redisTestHooks } from "@/lib/cache/redis";
import type { MemoryResult } from "@/lib/memory/types";
import {
  createMockPrisma,
  createSequentialQueryRaw,
  mockArticle,
  mockSearchRow,
  withRecallHydrationQueries,
} from "../memory/noosphere-provider-helpers";
import assert from "assert";

class FakeRedisClient {
  status = "wait";
  private readonly store = new Map<string, string>();
  private setexCalls = 0;
  private readonly setexWaiters: (() => void)[] = [];

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
    this.setexCalls++;
    this.setexWaiters.shift()?.();
    return "OK";
  }

  async incr(key: string) {
    this.assertReady();
    const value = Number(this.store.get(key) ?? "0") + 1;
    this.store.set(key, String(value));
    return value;
  }

  waitForSetexCall(expectedCalls = this.setexCalls + 1) {
    if (this.setexCalls >= expectedCalls) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.setexWaiters.push(resolve);
    });
  }

  peek(key: string) {
    return this.store.get(key);
  }

  private assertReady() {
    if (this.status !== "ready") {
      throw new Error("Redis command executed before client was ready");
    }
  }
}

async function withRestoredDatabaseUrl<T>(fn: () => Promise<T>): Promise<T> {
  const previousDatabaseUrl = process.env.DATABASE_URL;

  try {
    return await fn();
  } finally {
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
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
      assert.deepStrictEqual(cached, [{ id: cachedResult.id }]);
      const raw = redis.peek(cacheKey);
      assert.ok(raw);
      assert.equal(raw!.includes("Cached content"), false);
      assert.equal(raw!.includes("Cached Article"), false);
    } finally {
      _redisTestHooks.reset();
    }
  });

  it("rehydrates cache hits and drops articles that became ineligible", async () => {
    await withRestoredDatabaseUrl(async () => {
      const redis = new FakeRedisClient();
      _redisTestHooks.setClientForTesting(redis as never);
      try {
        const { NoosphereProvider } = await import("@/lib/memory/noosphere");
        let hydrationCount = 0;
        const provider = new NoosphereProvider({
          prisma: createMockPrisma({
            $queryRaw: withRecallHydrationQueries(() =>
              Promise.resolve([mockSearchRow()]),
            ),
            article: {
              findMany: () => {
                hydrationCount++;
                return Promise.resolve(
                  hydrationCount === 1
                    ? [mockArticle({ id: "article-1" })]
                    : [],
                );
              },
            },
          }),
        });

        assert.equal((await provider.search("quarantine race")).length, 1);
        await redis.waitForSetexCall(1);
        assert.equal((await provider.search("quarantine race")).length, 0);
      } finally {
        _redisTestHooks.reset();
      }
    });
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

  it("moves recall cache reads to a new key after invalidation", async () => {
    const redis = new FakeRedisClient();
    _redisTestHooks.setClientForTesting(redis as never);

    try {
      const initialVersion = await getSearchCacheVersion();
      assert.strictEqual(initialVersion, "0");

      const staleCacheKey = buildSearchCacheKey({
        query: "versioned recall",
        cacheVersion: initialVersion,
      });
      await setCachedSearchResults(staleCacheKey, [cachedResult], initialVersion);
      assert.deepStrictEqual(await getCachedSearchResults(staleCacheKey), [
        { id: cachedResult.id },
      ]);

      await invalidateSearchCache();
      const nextVersion = await getSearchCacheVersion();
      assert.strictEqual(nextVersion, "1");

      const nextCacheKey = buildSearchCacheKey({
        query: "versioned recall",
        cacheVersion: nextVersion,
      });
      assert.notStrictEqual(nextCacheKey, staleCacheKey);
      assert.strictEqual(await getCachedSearchResults(nextCacheKey), null);
    } finally {
      _redisTestHooks.reset();
    }
  });

  it("moves NoosphereProvider recall reads off stale cache entries after invalidation", async () => {
    await withRestoredDatabaseUrl(async () => {
      const redis = new FakeRedisClient();
      _redisTestHooks.setClientForTesting(redis as never);

      try {
        const { NoosphereProvider } = await import("@/lib/memory/noosphere");
        let hydrationCount = 0;
        const provider = new NoosphereProvider({
          prisma: createMockPrisma({
            $queryRaw: withRecallHydrationQueries(
              createSequentialQueryRaw([
                [mockSearchRow({ title: "Before invalidation" })],
                [mockSearchRow({ title: "After invalidation" })],
              ]),
            ),
            article: {
              findMany: () => {
                hydrationCount++;
                const title = hydrationCount < 3
                  ? "Before invalidation"
                  : "After invalidation";
                return Promise.resolve([mockArticle({ id: "article-1", title })]);
              },
            },
          }),
        });

        const initialResults = await provider.search("versioned recall");
        assert.strictEqual(initialResults[0]?.title, "Before invalidation");
        await redis.waitForSetexCall(1);

        const cachedResults = await provider.search("versioned recall");
        assert.strictEqual(cachedResults[0]?.title, "Before invalidation");

        await invalidateSearchCache();
        const refreshedResults = await provider.search("versioned recall");
        assert.strictEqual(refreshedResults[0]?.title, "After invalidation");
        await redis.waitForSetexCall(2);
      } finally {
        _redisTestHooks.reset();
      }
    });
  });
});
