/**
 * NoosphereProvider — Unit Tests
 *
 * Run with: npx tsx src/__tests__/memory/noosphere-provider.test.ts
 *
 * Tests cover:
 * 1. Constructor validation (descriptor, config overrides, factory)
 * 2. search() edge cases (empty query, disabled config, no results)
 * 3. getById() (found, not found, disabled, canonical ref stripping)
 * 4. score() (non-noosphere guard, aggregate, recency decay)
 * 5. Confidence and curation level mapping via getById
 * 6. Descriptor metadata
 */

// Provide a dummy DATABASE_URL so the default Prisma client import doesn't crash.
// Tests inject their own mock Prisma, so this connection string is never used.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
}

import type { PrismaClient } from "@prisma/client";
import {
  NoosphereProvider,
  createNoosphereProvider,
} from "@/lib/memory/noosphere";

// ─── Test helpers ────────────────────────────────────────────────────────────

let testCounter = 0;
let passCount = 0;
let failCount = 0;
const pending: Promise<void>[] = [];

function test(name: string, fn: () => void | Promise<void>): void {
  testCounter++;
  const label = `[${testCounter}] ${name}`;
  const p = Promise.resolve()
    .then(() => fn())
    .then(() => {
      passCount++;
      console.log(`  ✓ ${label}`);
    })
    .catch((err: unknown) => {
      failCount++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${label}\n    ${message}`);
    });
  pending.push(p);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertApprox(
  actual: number,
  expected: number,
  tolerance: number,
  label: string,
): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(
      `${label}: expected ~${expected} (±${tolerance}), got ${actual}`,
    );
  }
}

// ─── Mock Prisma ─────────────────────────────────────────────────────────────

function createMockPrisma(
  overrides: Record<string, unknown> = {},
): PrismaClient {
  return {
    article: {
      findFirst: (() =>
        Promise.resolve(null)) as unknown as PrismaClient["article"]["findFirst"],
      findMany: (() =>
        Promise.resolve(
          [],
        )) as unknown as PrismaClient["article"]["findMany"],
    },
    $queryRaw: (() =>
      Promise.resolve([])) as unknown as PrismaClient["$queryRaw"],
    ...overrides,
  } as unknown as PrismaClient;
}

// ─── Shared mock article factory ────────────────────────────────────────────

function mockArticle(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-id",
    title: "Test Article",
    slug: "test-article",
    content: "Test content body",
    excerpt: "Test excerpt",
    status: "published",
    confidence: "high",
    sourceUrl: null,
    sourceType: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-04-01"),
    lastReviewed: null,
    authorId: null,
    authorName: null,
    topicId: "topic-1",
    topic: { id: "topic-1", slug: "engineering", name: "Engineering" },
    tags: [],
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🔍 NoosphereProvider Tests\n");

  // ─── Constructor ─────────────────────────────────────────────────────────

  test("constructor uses default Prisma when none provided", () => {
    const provider = new NoosphereProvider();
    assertEqual(provider.descriptor.id, "noosphere", "provider id");
    assertEqual(provider.descriptor.sourceType, "noosphere", "source type");
    assertEqual(
      provider.descriptor.capabilities.search,
      true,
      "search cap",
    );
    assertEqual(
      provider.descriptor.capabilities.getById,
      true,
      "getById cap",
    );
    assertEqual(provider.descriptor.capabilities.score, true, "score cap");
    assertEqual(
      provider.descriptor.capabilities.autoRecall,
      true,
      "autoRecall cap",
    );
  });

  test("constructor applies providerConfig overrides", () => {
    const provider = new NoosphereProvider({
      providerConfig: { priorityWeight: 2.5, maxResults: 5 },
    });
    assertEqual(
      provider.descriptor.defaultConfig.priorityWeight,
      2.5,
      "priorityWeight override",
    );
    assertEqual(
      provider.descriptor.defaultConfig.maxResults,
      5,
      "maxResults override",
    );
  });

  test("createNoosphereProvider factory returns instance", () => {
    const provider = createNoosphereProvider();
    assert(provider instanceof NoosphereProvider, "instance check");
  });

  // ─── search() ───────────────────────────────────────────────────────────

  test("search returns empty array for empty query", async () => {
    const provider = new NoosphereProvider({
      prisma: createMockPrisma(),
    });
    const results = await provider.search("  ");
    assertEqual(results.length, 0, "empty query results");
  });

  test("search returns empty array when disabled", async () => {
    const provider = new NoosphereProvider({
      prisma: createMockPrisma(),
      providerConfig: { enabled: false },
    });
    const results = await provider.search("test", {
      config: { enabled: false },
    });
    assertEqual(results.length, 0, "disabled results");
  });

  test("search returns empty array when raw query yields no results", async () => {
    const provider = new NoosphereProvider({
      prisma: createMockPrisma({
        $queryRaw: () => Promise.resolve([]),
      }),
    });
    const results = await provider.search("nonexistent topic");
    assertEqual(results.length, 0, "no results");
  });

  // ─── getById() ──────────────────────────────────────────────────────────

  test("getById returns null when article not found", async () => {
    const provider = new NoosphereProvider({
      prisma: createMockPrisma({
        article: { findFirst: () => Promise.resolve(null) },
      }),
    });
    const result = await provider.getById("nonexistent-id");
    assertEqual(result, null, "not found");
  });

  test("getById returns null when disabled", async () => {
    const provider = new NoosphereProvider({
      prisma: createMockPrisma(),
      providerConfig: { enabled: false },
    });
    const result = await provider.getById("some-id", {
      config: { enabled: false },
    });
    assertEqual(result, null, "disabled getById");
  });

  test("getById strips noosphere:article: prefix from id", async () => {
    let capturedId: string | undefined;
    const provider = new NoosphereProvider({
      prisma: createMockPrisma({
        article: {
          findFirst: (args: Record<string, unknown>) => {
            const where = args.where as { id: string };
            capturedId = where.id;
            return Promise.resolve(mockArticle({ id: "abc123" }));
          },
        },
      }),
    });

    const result = await provider.getById("noosphere:article:abc123");
    assertEqual(capturedId, "abc123", "stripped prefix");
    assert(result !== null, "result should not be null");
    assertEqual(result!.provider, "noosphere", "provider field");
    assertEqual(result!.sourceType, "noosphere", "sourceType field");
    assertEqual(result!.title, "Test Article", "title");
    assertEqual(result!.content, "Test content body", "content");
    assertEqual(result!.summary, "Test excerpt", "summary");
    assertEqual(
      result!.curationLevel,
      "curated",
      "curation level for published",
    );
    assertEqual(
      result!.canonicalRef,
      "noosphere:article:abc123",
      "canonical ref",
    );
  });

  test("getById maps confidence and recency from article fields", async () => {
    const provider = new NoosphereProvider({
      prisma: createMockPrisma({
        article: {
          findFirst: () =>
            Promise.resolve(
              mockArticle({
                confidence: "high",
                updatedAt: new Date("2026-04-25"),
              }),
            ),
        },
      }),
    });
    const result = await provider.getById("test");
    assert(result !== null, "result exists");
    assertEqual(result!.confidenceScore, 1, "high confidence → 1");
    // recencyScore depends on current time vs updatedAt, so just verify it's high.
    assert(
      result!.recencyScore !== undefined && result!.recencyScore! > 0.9,
      "recent article → recency > 0.9",
    );
  });

  // ─── score() ────────────────────────────────────────────────────────────

  test("score returns empty object for non-noosphere results", () => {
    const provider = new NoosphereProvider({ prisma: createMockPrisma() });
    const score = provider.score({
      id: "1",
      provider: "hindsight",
      sourceType: "hindsight",
      content: "test",
    });
    assertEqual(Object.keys(score).length, 0, "no keys for non-noosphere");
  });

  test("score computes aggregate from available signals", () => {
    const provider = new NoosphereProvider({ prisma: createMockPrisma() });
    const score = provider.score({
      id: "1",
      provider: "noosphere",
      sourceType: "noosphere",
      content: "test",
      relevanceScore: 0.8,
      confidenceScore: 1.0,
      updatedAt: new Date("2026-04-01").toISOString(),
    });
    assert(score.aggregateScore !== undefined, "aggregate should exist");
    assert(score.aggregateScore! > 0, "aggregate > 0");
    assert(score.aggregateScore! <= 1, "aggregate <= 1");
    assert(score.reasons !== undefined, "reasons should exist");
    assert(score.reasons!.length > 0, "reasons should not be empty");
  });

  test("score returns undefined aggregate when no signals present", () => {
    const provider = new NoosphereProvider({ prisma: createMockPrisma() });
    const score = provider.score({
      id: "1",
      provider: "noosphere",
      sourceType: "noosphere",
      content: "test",
    });
    assertEqual(
      score.aggregateScore,
      undefined,
      "no aggregate without signals",
    );
  });

  test("score recency decays with 90-day half-life", () => {
    const provider = new NoosphereProvider({ prisma: createMockPrisma() });
    const now = new Date("2026-04-25");

    // Fresh article (0 days old) → recency 1
    const fresh = provider.score(
      {
        id: "1",
        provider: "noosphere",
        sourceType: "noosphere",
        content: "test",
        updatedAt: now.toISOString(),
      },
      { now },
    );
    assertEqual(fresh.recencyScore, 1, "fresh article score");

    // 90 days old → half-life ≈ 0.5
    const ninetyDaysAgo = new Date(
      now.getTime() - 90 * 24 * 60 * 60 * 1000,
    );
    const old = provider.score(
      {
        id: "2",
        provider: "noosphere",
        sourceType: "noosphere",
        content: "test",
        updatedAt: ninetyDaysAgo.toISOString(),
      },
      { now },
    );
    assert(old.recencyScore !== undefined, "old recency should exist");
    assertApprox(old.recencyScore!, 0.5, 0.01, "90-day half-life");

    // 365 days old → very decayed
    const yearAgo = new Date(
      now.getTime() - 365 * 24 * 60 * 60 * 1000,
    );
    const ancient = provider.score(
      {
        id: "3",
        provider: "noosphere",
        sourceType: "noosphere",
        content: "test",
        updatedAt: yearAgo.toISOString(),
      },
      { now },
    );
    assert(ancient.recencyScore !== undefined, "ancient recency exists");
    assert(ancient.recencyScore! < 0.1, "365-day < 0.1");
  });

  // ─── Confidence mapping via getById ─────────────────────────────────────

  test("confidence: high=1, medium=0.66, low=0.33, null=undefined", async () => {
    const cases: [string | null, number | undefined][] = [
      ["high", 1],
      ["medium", 0.66],
      ["low", 0.33],
      [null, undefined],
    ];

    for (const [confidence, expected] of cases) {
      const provider = new NoosphereProvider({
        prisma: createMockPrisma({
          article: {
            findFirst: () =>
              Promise.resolve(mockArticle({ confidence })),
          },
        }),
      });
      const result = await provider.getById("test");
      assert(result !== null, `result exists for confidence=${confidence}`);
      if (expected === undefined) {
        assertEqual(
          result!.confidenceScore,
          undefined,
          `confidence=${confidence}`,
        );
      } else {
        assertApprox(
          result!.confidenceScore!,
          expected,
          0.01,
          `confidence=${confidence}`,
        );
      }
    }
  });

  // ─── Curation level mapping via getById ─────────────────────────────────

  test("curation: published=curated, reviewed=reviewed, draft=ephemeral", async () => {
    const cases: [string, string][] = [
      ["published", "curated"],
      ["reviewed", "reviewed"],
      ["draft", "ephemeral"],
    ];

    for (const [status, expected] of cases) {
      const provider = new NoosphereProvider({
        prisma: createMockPrisma({
          article: {
            findFirst: () => Promise.resolve(mockArticle({ status })),
          },
        }),
      });
      const result = await provider.getById("test");
      assertEqual(
        result?.curationLevel,
        expected as "curated" | "reviewed" | "ephemeral",
        `status=${status}`,
      );
    }
  });

  // ─── Descriptor metadata ───────────────────────────────────────────────

  test("descriptor has correct default priority weight", () => {
    const provider = new NoosphereProvider();
    assertEqual(
      provider.descriptor.defaultConfig.priorityWeight,
      1.25,
      "default priority",
    );
  });

  test("descriptor metadata includes contentType article", () => {
    const provider = new NoosphereProvider();
    assertEqual(
      provider.descriptor.metadata?.contentType,
      "article",
      "contentType",
    );
  });

  // ─── Wait for all async tests ───────────────────────────────────────────

  await Promise.all(pending);

  console.log(
    `\n  ${passCount} passed, ${failCount} failed, ${testCounter} total\n`,
  );

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
