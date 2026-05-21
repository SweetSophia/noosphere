import { describe, it } from "node:test";
import { buildSearchCacheKey } from "@/lib/cache/search-cache";
import assert from "assert";

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

describe("Prisma Cache Invalidation Extension", () => {
  it("should trigger invalidateSearchCache on write operations", async () => {
    const { prisma } = require("@/lib/prisma");
    const { _testHooks } = require("@/lib/cache/search-cache");

    const startCount = _testHooks.invalidateSearchCacheCallCount;

    try {
      await prisma.activityLog.create({
        data: {
          type: "test",
          title: "Test Invalidation",
          details: {},
        },
      });

      assert.strictEqual(_testHooks.invalidateSearchCacheCallCount, startCount + 1);
    } finally {
      try {
        await prisma.activityLog.deleteMany({
          where: {
            title: "Test Invalidation",
          },
        });
      } catch (err) {
        console.error("Failed to clean up test activity log:", err);
      }
      await prisma.$disconnect();
      try {
        const { closeRedisClient } = require("@/lib/cache/redis");
        await closeRedisClient();
      } catch (err) {
        console.error("Failed to close Redis client in test:", err);
      }
    }
  });
});
