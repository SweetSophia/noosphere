import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgresql://noosphere:noosphere@localhost:5432/noosphere";

test("memory recall rate limit defaults to concurrent CLI-friendly read capacity", async () => {
  await withRestoredRateLimitEnv(async () => {
    const {
      DEFAULT_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE,
      MEMORY_RECALL_RATE_LIMIT_ENV,
      getMemoryRecallRateLimitOptions,
    } = await import("@/app/api/memory/recall/route");
    delete process.env[MEMORY_RECALL_RATE_LIMIT_ENV];

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
    const {
      MEMORY_RECALL_RATE_LIMIT_ENV,
      getMemoryRecallRateLimitOptions,
    } = await import("@/app/api/memory/recall/route");
    process.env[MEMORY_RECALL_RATE_LIMIT_ENV] = "240";

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
      MEMORY_RECALL_RATE_LIMIT_ENV,
      getMemoryRecallRateLimitOptions,
    } = await import("@/app/api/memory/recall/route");
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];

    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      for (const value of invalidValues) {
        process.env[MEMORY_RECALL_RATE_LIMIT_ENV] = value;

        assert.equal(
          getMemoryRecallRateLimitOptions().maxRequests,
          DEFAULT_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE,
        );
      }
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, invalidValues.length);
    assert.match(String(warnings[0]?.[0]), /Ignoring invalid/);
  });
});

async function withRestoredRateLimitEnv(run: () => Promise<void>) {
  const { MEMORY_RECALL_RATE_LIMIT_ENV } = await import("@/app/api/memory/recall/route");
  const previous = process.env[MEMORY_RECALL_RATE_LIMIT_ENV];
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env[MEMORY_RECALL_RATE_LIMIT_ENV];
    } else {
      process.env[MEMORY_RECALL_RATE_LIMIT_ENV] = previous;
    }
  }
}
