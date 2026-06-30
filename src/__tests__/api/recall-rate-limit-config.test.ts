import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgresql://noosphere:noosphere@localhost:5432/noosphere";

test("memory recall rate limit defaults to concurrent CLI-friendly read capacity", async () => {
  const previous = process.env.NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE;
  delete process.env.NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE;

  try {
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
  } finally {
    if (previous === undefined) {
      delete process.env.NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE;
    } else {
      process.env.NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE = previous;
    }
  }
});

test("memory recall rate limit can be tuned by environment", async () => {
  const previous = process.env.NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE;
  process.env.NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE = "240";

  try {
    const { getMemoryRecallRateLimitOptions } = await import("@/app/api/memory/recall/route");

    assert.equal(getMemoryRecallRateLimitOptions().maxRequests, 240);
  } finally {
    if (previous === undefined) {
      delete process.env.NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE;
    } else {
      process.env.NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE = previous;
    }
  }
});

test("memory recall rate limit ignores invalid environment values", async () => {
  const previous = process.env.NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE;
  const invalidValues = ["0", "-1", "1.5", "240abc", "not-a-number"];

  const {
    DEFAULT_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE,
    getMemoryRecallRateLimitOptions,
  } = await import("@/app/api/memory/recall/route");

  try {
    for (const value of invalidValues) {
      process.env.NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE = value;

      assert.equal(
        getMemoryRecallRateLimitOptions().maxRequests,
        DEFAULT_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE,
      );
    }
  } finally {
    restoreRateLimitEnv(previous);
  }
});

function restoreRateLimitEnv(previous: string | undefined) {
  if (previous === undefined) {
    delete process.env.NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE;
  } else {
    process.env.NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE = previous;
  }
}
