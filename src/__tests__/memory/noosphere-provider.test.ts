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

import {
  NoosphereProvider,
  createNoosphereProvider,
} from "@/lib/memory/noosphere";
import type { MemoryCurationLevel } from "@/lib/memory/types";
import {
  HybridCorrectnessError,
  HybridLexicalFallbackError,
} from "@/lib/memory/hybrid-retrieval";
import {
  createMockPrisma,
  createSequentialQueryRaw,
  findManyFromArticles,
  mockArticle,
  mockSearchRow,
  withRecallHydrationQueries,
} from "./noosphere-provider-helpers";

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

  test("search uses Phase C within the bounded window and maps RRF metadata", async () => {
    let hybridCalls = 0;
    const provider = new NoosphereProvider({
      prisma: createMockPrisma(),
      environment: hybridEnvironment(),
      hybridSearch: async (_prisma, request) => {
        hybridCalls++;
        assertEqual(request.offset, 2, "hybrid offset");
        assertEqual(request.allowedScopes?.[0], "team:a", "hybrid scope");
        return [{
          id: "hybrid-1",
          rawRrfScore: 2 / 61,
          lexicalRank: 1,
          vectorRank: 1,
          relevanceScore: 1,
          title: "Hybrid result",
          slug: "hybrid-result",
          content: "Current authorized content",
          excerpt: null,
          status: "published",
          confidence: "high",
          sourceUrl: null,
          sourceType: null,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          updatedAt: new Date("2026-01-02T00:00:00Z"),
          lastReviewed: null,
          authorId: null,
          authorName: null,
          topicId: "topic-1",
          topicSlug: "engineering",
          topicName: "Engineering",
          tags: ["recall"],
        }];
      },
      allowedScopes: ["team:a"],
    });

    const results = await provider.search("hybrid recall", {
      limit: 10,
      metadata: { offset: 2 },
    });
    assertEqual(hybridCalls, 1, "hybrid call count");
    assertEqual(results[0].id, "hybrid-1", "hybrid result id");
    assertEqual(results[0].relevanceScore, 1, "normalized relevance");
    assertEqual(results[0].metadata?.hybridRawRrfScore, 2 / 61, "raw RRF metadata");
  });

  test("typed Phase C transient failures fall back while correctness failures surface", async () => {
    const transient = new NoosphereProvider({
      prisma: createMockPrisma({ $queryRaw: () => Promise.resolve([]) }),
      environment: hybridEnvironment(),
      hybridSearch: async () => {
        throw new HybridLexicalFallbackError("provider_http_503");
      },
    });
    assertEqual((await transient.search("hybrid recall")).length, 0, "lexical fallback result");

    const correctness = new NoosphereProvider({
      prisma: createMockPrisma(),
      environment: hybridEnvironment(),
      hybridSearch: async () => {
        throw new HybridCorrectnessError("provider_vector_invalid");
      },
    });
    let surfaced = false;
    try {
      await correctness.search("hybrid recall");
    } catch (error) {
      surfaced = error instanceof HybridCorrectnessError;
    }
    assert(surfaced, "correctness failure must surface");
  });

  test("Phase C uses classified lexical fallback for windows beyond 200", async () => {
    let hybridCalls = 0;
    const provider = new NoosphereProvider({
      prisma: createMockPrisma({ $queryRaw: () => Promise.resolve([]) }),
      environment: hybridEnvironment(),
      hybridSearch: async () => {
        hybridCalls++;
        return [];
      },
    });
    await provider.search("hybrid recall", { limit: 10, metadata: { offset: 195 } });
    assertEqual(hybridCalls, 0, "hybrid deep-window calls");
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

  test("search does not retry fallback when strict query returns results", async () => {
    let queryCount = 0;
    const article = mockArticle({ id: "strict-1" });
    const provider = new NoosphereProvider({
      prisma: createMockPrisma({
        $queryRaw: withRecallHydrationQueries(() => {
          queryCount++;
          return Promise.resolve([mockSearchRow({ id: "strict-1" })]);
        }),
        article: { findMany: findManyFromArticles([article]) },
      }),
    });

    const results = await provider.search("avatar portrait");

    assertEqual(queryCount, 1, "strict query only");
    assertEqual(results.length, 1, "strict result count");
    assertEqual(results[0].id, "strict-1", "strict result id");
  });

  test("search retries with synonym fallback when strict query yields no results", async () => {
    let queryCount = 0;
    const queryRaw = createSequentialQueryRaw([
      [],
      [
        mockSearchRow({
          id: "portrait-1",
          title: "Cybera avatar portrait",
          content: "Telegram profile picture and avatar portrait reference.",
          tagName: "avatar",
        }),
        mockSearchRow({
          id: "portrait-1",
          title: "Cybera avatar portrait",
          content: "Telegram profile picture and avatar portrait reference.",
          tagName: "portrait",
        }),
      ],
    ]);
    const provider = new NoosphereProvider({
      prisma: createMockPrisma({
        $queryRaw: withRecallHydrationQueries((...args: unknown[]) => {
          void args;
          queryCount++;
          return queryRaw();
        }),
        article: {
          findMany: findManyFromArticles([
            mockArticle({
              id: "portrait-1",
              title: "Cybera avatar portrait",
              content: "Telegram profile picture and avatar portrait reference.",
              tags: [
                { tag: { name: "avatar" } },
                { tag: { name: "portrait" } },
              ],
            }),
          ]),
        },
      }),
    });

    const results = await provider.search("forgot photo reattach");

    assertEqual(queryCount, 2, "strict query then fallback query");
    assertEqual(results.length, 1, "fallback result count");
    assertEqual(results[0].id, "portrait-1", "fallback result id");
    assertEqual(results[0].tags?.join(","), "avatar,portrait", "fallback tags");
  });

  test("search skips fallback on paginated empty strict pages with earlier strict matches", async () => {
    let queryCount = 0;
    const queryRaw = createSequentialQueryRaw([
      [],
      [{ exists: true }],
      [mockSearchRow({ id: "fallback-should-not-run" })],
    ]);
    const provider = new NoosphereProvider({
      prisma: createMockPrisma({
        $queryRaw: () => {
          queryCount++;
          return queryRaw();
        },
      }),
    });

    const results = await provider.search("photo", {
      metadata: { offset: 10 },
    });

    assertEqual(queryCount, 2, "strict page query plus global strict existence check");
    assertEqual(results.length, 0, "empty strict page remains empty");
  });

  test("search skips fallback when relaxed query has no useful terms", async () => {
    let queryCount = 0;
    const provider = new NoosphereProvider({
      prisma: createMockPrisma({
        $queryRaw: () => {
          queryCount++;
          return Promise.resolve([]);
        },
      }),
    });

    const results = await provider.search("the and of is are was were be been being has had do does did will may might can shall");

    assertEqual(queryCount, 1, "strict query only");
    assertEqual(results.length, 0, "no fallback results");
  });

  // ─── getById() ──────────────────────────────────────────────────────────

  test("getById returns null when article not found", async () => {
    const provider = new NoosphereProvider({
      prisma: createMockPrisma({
        $queryRaw: withRecallHydrationQueries(() => Promise.resolve([])),
        article: { findMany: () => Promise.resolve([]) },
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
        $queryRaw: withRecallHydrationQueries(() => Promise.resolve([])),
        article: {
          findMany: (args: { where: { id: { in: string[] } } }) => {
            capturedId = args.where.id.in[0];
            return Promise.resolve([mockArticle({ id: "abc123" })]);
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
        $queryRaw: withRecallHydrationQueries(() => Promise.resolve([])),
        article: {
          findMany: () =>
            Promise.resolve([
              mockArticle({
                id: "test",
                confidence: "high",
                updatedAt: new Date(),
              }),
            ]),
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
          $queryRaw: withRecallHydrationQueries(() => Promise.resolve([])),
          article: {
            findMany: () =>
              Promise.resolve([mockArticle({ id: "test", confidence })]),
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

  test("curation: published=curated, reviewed=managed, draft=ephemeral", async () => {
    const cases: [string, string][] = [
      ["published", "curated"],
      ["reviewed", "managed"],
      ["draft", "ephemeral"],
    ];

    for (const [status, expected] of cases) {
      const provider = new NoosphereProvider({
        prisma: createMockPrisma({
          $queryRaw: withRecallHydrationQueries(() => Promise.resolve([])),
          article: {
            findMany: () => Promise.resolve([mockArticle({ id: "test", status })]),
          },
        }),
      });
      const result = await provider.getById("test");
      assertEqual(
        result?.curationLevel,
        expected as MemoryCurationLevel,
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

function hybridEnvironment(): Record<string, string | undefined> {
  return {
    NOOSPHERE_HYBRID_RETRIEVAL_ENABLED: "true",
    NOOSPHERE_HYBRID_QUERY_PROFILE_ID: "0198fe17-f4dd-7ee3-93e4-acde00000001",
    NOOSPHERE_HYBRID_CACHE_HMAC_ACTIVE_VERSION: "v1",
    NOOSPHERE_HYBRID_CACHE_HMAC_KEYS: JSON.stringify({
      v1: Buffer.alloc(32, 7).toString("base64"),
    }),
  };
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
