import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgresql://noosphere:noosphere@localhost:5432/noosphere";

test("memory recall rate limit defaults to concurrent CLI-friendly read capacity", async () => {
  await withRestoredRateLimitEnv(async () => {
    delete process.env.NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE;
    const {
      DEFAULT_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE,
      getMemoryRecallRateLimitOptions,
    } = await import("@/app/api/memory/recall/route");

    assert.deepEqual(getMemoryRecallRateLimitOptions(), {
      windowMs: 60_000,
      maxRequests: DEFAULT_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE,
      keyPrefix: "memory-recall",
    });
    assert.equal(DEFAULT_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE, 120);
  });
});

test("memory recall rate limit can be tuned by environment", async () => {
  await withRestoredRateLimitEnv(async () => {
    process.env.NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE = "240";
    const { getMemoryRecallRateLimitOptions } = await import("@/app/api/memory/recall/route");

    assert.equal(getMemoryRecallRateLimitOptions().maxRequests, 240);
  });
});

test("memory recall rate limit ignores invalid environment values", async () => {
  await withRestoredRateLimitEnv(async () => {
    const invalidValues = [
      "0",
      "-1",
      "1.5",
      "240abc",
      "not-a-number",
      "9007199254740992",
    ];

    const {
      DEFAULT_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE,
      getMemoryRecallRateLimitOptions,
    } = await import("@/app/api/memory/recall/route");

    for (const value of invalidValues) {
      process.env.NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE = value;

      assert.equal(
        getMemoryRecallRateLimitOptions().maxRequests,
        DEFAULT_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE,
      );
    }
  });
});

async function withRestoredRateLimitEnv(run: () => Promise<void>) {
  const previous = process.env.NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE;
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env.NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE;
    } else {
      process.env.NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE = previous;
    }
  }
}
