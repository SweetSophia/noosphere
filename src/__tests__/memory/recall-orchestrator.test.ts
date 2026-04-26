/**
 * RecallOrchestrator — Unit Tests
 *
 * Run with: DATABASE_URL="postgresql://test:test@localhost:5432/test" npx tsx src/__tests__/memory/recall-orchestrator.test.ts
 *
 * Tests cover:
 * 1. Constructor validation (empty providers, defaults)
 * 2. Fan-out (enabled/disabled providers, auto-recall gating, error handling)
 * 3. Ranking (composite score, deduplication, ordering)
 * 4. Token budget (auto mode truncation, summary fallback)
 * 5. Prompt injection formatting (XML output, escaping)
 * 6. Inspection mode (structured output, no budget truncation)
 */

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
}

import type { MemoryProvider } from "@/lib/memory/provider";
import type { MemoryResult } from "@/lib/memory/types";
import {
  RecallOrchestrator,
  createRecallOrchestrator,
} from "@/lib/memory/orchestrator";

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

// ─── Mock providers ──────────────────────────────────────────────────────────

function mockProvider(
  id: string,
  results: MemoryResult[] = [],
  overrides: Partial<MemoryProvider> = {},
): MemoryProvider {
  return {
    descriptor: {
      id,
      displayName: id,
      sourceType: id as MemoryResult["sourceType"],
      defaultConfig: {
        enabled: true,
        priorityWeight: 1,
        allowAutoRecall: true,
      },
      capabilities: {
        search: true,
        getById: true,
        score: true,
        autoRecall: true,
      },
    },
    search: () => Promise.resolve(results),
    getById: () => Promise.resolve(null),
    score: () => ({}),
    ...overrides,
  } as MemoryProvider;
}

function mockResult(
  overrides: Partial<MemoryResult> & { id: string; provider: string },
): MemoryResult {
  return {
    sourceType: overrides.provider as MemoryResult["sourceType"],
    content: `Content for ${overrides.id}`,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🧠 RecallOrchestrator Tests\n");

  // ─── Constructor ─────────────────────────────────────────────────────────

  test("constructor throws with no providers", () => {
    let threw = false;
    try {
      new RecallOrchestrator({ providers: [] });
    } catch {
      threw = true;
    }
    assert(threw, "should throw on empty providers");
  });

  test("constructor accepts valid providers", () => {
    const orchestrator = new RecallOrchestrator({
      providers: [{ provider: mockProvider("test") }],
    });
    assert(orchestrator instanceof RecallOrchestrator, "instance check");
  });

  test("constructor rejects duplicate provider IDs", () => {
    let threw = false;
    try {
      new RecallOrchestrator({
        providers: [
          { provider: mockProvider("duplicate") },
          { provider: mockProvider("duplicate") },
        ],
      });
    } catch {
      threw = true;
    }
    assert(threw, "should throw on duplicate provider IDs");
  });

  test("createRecallOrchestrator factory returns instance", () => {
    const orchestrator = createRecallOrchestrator({
      providers: [{ provider: mockProvider("test") }],
    });
    assert(orchestrator instanceof RecallOrchestrator, "factory instance");
  });

  // ─── Basic recall (inspection mode) ─────────────────────────────────────

  test("returns empty results for empty provider output", async () => {
    const orchestrator = new RecallOrchestrator({
      providers: [{ provider: mockProvider("empty") }],
    });
    const response = await orchestrator.recall({
      query: "test query",
      mode: "inspection",
    });
    assertEqual(response.results.length, 0, "empty results");
    assertEqual(response.totalBeforeCap, 0, "total before cap");
    assertEqual(response.mode, "inspection", "mode");
    assertEqual(response.promptInjectionText, undefined, "no prompt text");
  });

  test("returns results from single provider", async () => {
    const results = [
      mockResult({
        id: "1",
        provider: "noosphere",
        title: "Article A",
        content: "Content A",
        relevanceScore: 0.9,
      }),
      mockResult({
        id: "2",
        provider: "noosphere",
        title: "Article B",
        content: "Content B",
        relevanceScore: 0.5,
      }),
    ];
    const orchestrator = new RecallOrchestrator({
      providers: [{ provider: mockProvider("noosphere", results) }],
    });

    const response = await orchestrator.recall({
      query: "test",
      mode: "inspection",
    });

    assertEqual(response.results.length, 2, "result count");
    assertEqual(response.results[0].rank, 1, "first rank");
    assertEqual(response.results[0].title, "Article A", "first title (highest relevance)");
    assertEqual(response.results[0].providerId, "noosphere", "provider id");
    assert(response.results[0].compositeScore > 0, "composite score > 0");
  });

  test("merges results from multiple providers", async () => {
    const noosphereResults = [
      mockResult({
        id: "n1",
        provider: "noosphere",
        title: "Wiki Article",
        content: "Wiki content",
        relevanceScore: 0.8,
      }),
    ];
    const hindsightResults = [
      mockResult({
        id: "h1",
        provider: "hindsight",
        title: "Memory",
        content: "Hindsight content",
        relevanceScore: 0.6,
      }),
    ];

    const orchestrator = new RecallOrchestrator({
      providers: [
        { provider: mockProvider("noosphere", noosphereResults) },
        { provider: mockProvider("hindsight", hindsightResults) },
      ],
    });

    const response = await orchestrator.recall({
      query: "test",
      mode: "inspection",
    });

    assertEqual(response.results.length, 2, "merged count");
    assertEqual(response.providerMeta.length, 2, "provider meta count");
    // Higher relevance should rank first.
    assertEqual(
      response.results[0].providerId,
      "noosphere",
      "noosphere ranks higher",
    );
  });

  // ─── Disabled providers ─────────────────────────────────────────────────

  test("skips disabled providers", async () => {
    const orchestrator = new RecallOrchestrator({
      providers: [
        {
          provider: mockProvider("enabled", [
            mockResult({ id: "1", provider: "enabled", content: "hi" }),
          ]),
        },
        {
          provider: mockProvider("disabled", []),
          config: { enabled: false },
        },
        {
          provider: mockProvider("second-enabled", [
            mockResult({ id: "2", provider: "second-enabled", content: "hello" }),
          ]),
        },
      ],
    });

    const response = await orchestrator.recall({
      query: "test",
      mode: "inspection",
    });

    assertEqual(response.providerMeta.length, 3, "all providers reported");
    assertEqual(response.providerMeta[0].providerId, "enabled", "enabled id");
    assertEqual(response.providerMeta[1].providerId, "disabled", "disabled id");
    assertEqual(response.providerMeta[1].enabled, false, "disabled provider marked disabled");
    assertEqual(
      response.providerMeta[1].skippedReason,
      "disabled",
      "disabled skip reason",
    );
    assertEqual(
      response.providerMeta[2].providerId,
      "second-enabled",
      "provider metadata preserves registration order",
    );
  });

  // ─── Auto-recall gating ─────────────────────────────────────────────────

  test("auto mode skips providers with autoRecall=false", async () => {
    const noAutoRecallProvider = mockProvider("no-auto", [], {
      descriptor: {
        ...mockProvider("no-auto").descriptor,
        capabilities: {
          search: true,
          getById: true,
          score: false,
          autoRecall: false,
        },
      },
    });

    const orchestrator = new RecallOrchestrator({
      providers: [{ provider: noAutoRecallProvider }],
    });

    const response = await orchestrator.recall({
      query: "test",
      mode: "auto",
    });

    assertEqual(response.results.length, 0, "no results from auto-blocked");
    assertEqual(response.providerMeta.length, 1, "provider skip reported");
    assertEqual(response.providerMeta[0].enabled, false, "provider marked skipped");
    assertEqual(
      response.providerMeta[0].skippedReason,
      "auto-recall-disabled",
      "auto capability skip reason",
    );
  });

  test("auto mode respects allowAutoRecall=false provider config", async () => {
    const provider = mockProvider("config-no-auto", [
      mockResult({ id: "1", provider: "config-no-auto", content: "hidden" }),
    ]);

    const orchestrator = new RecallOrchestrator({
      providers: [
        {
          provider,
          config: { allowAutoRecall: false },
        },
      ],
    });

    const response = await orchestrator.recall({
      query: "test",
      mode: "auto",
    });

    assertEqual(response.results.length, 0, "config blocks auto recall");
    assertEqual(
      response.providerMeta[0].skippedReason,
      "auto-recall-disabled",
      "config skip reason",
    );
  });

  // ─── Error handling ─────────────────────────────────────────────────────

  test("gracefully handles provider errors", async () => {
    const failingProvider = mockProvider("failing", [], {
      search: () => Promise.reject(new Error("DB connection lost")),
    });

    const orchestrator = new RecallOrchestrator({
      providers: [{ provider: failingProvider }],
    });

    const response = await orchestrator.recall({
      query: "test",
      mode: "inspection",
    });

    assertEqual(response.results.length, 0, "no results on error");
    assertEqual(response.providerMeta[0].providerId, "failing", "failed provider id");
    assertEqual(response.providerMeta[0].enabled, true, "failed provider still enabled");
    assertEqual(response.providerMeta[0].error, "DB connection lost", "error message");
  });

  test("respects provider query concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const makeDelayedProvider = (id: string) =>
      mockProvider(id, [], {
        search: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active--;
          return [mockResult({ id, provider: id, content: id })];
        },
      });

    const orchestrator = new RecallOrchestrator({
      providers: [
        { provider: makeDelayedProvider("p1") },
        { provider: makeDelayedProvider("p2") },
        { provider: makeDelayedProvider("p3") },
      ],
      concurrency: 1,
    });

    const response = await orchestrator.recall({
      query: "test",
      mode: "inspection",
    });

    assertEqual(response.results.length, 3, "all providers queried");
    assertEqual(maxActive, 1, "only one provider active at a time");
  });

  // ─── Deduplication ──────────────────────────────────────────────────────

  test("deduplicates results by canonicalRef", async () => {
    const results = [
      mockResult({
        id: "1",
        provider: "noosphere",
        canonicalRef: "noosphere:article:shared",
        content: "Version A",
        relevanceScore: 0.9,
      }),
      mockResult({
        id: "2",
        provider: "noosphere",
        canonicalRef: "noosphere:article:shared",
        content: "Version B",
        relevanceScore: 0.5,
      }),
    ];

    const orchestrator = new RecallOrchestrator({
      providers: [{ provider: mockProvider("noosphere", results) }],
    });

    const response = await orchestrator.recall({
      query: "test",
      mode: "inspection",
    });

    assertEqual(response.results.length, 1, "deduped to 1");
    assertEqual(response.results[0].content, "Version A", "kept higher relevance");
  });

  // ─── Global result cap ─────────────────────────────────────────────────

  test("respects global result cap", async () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      mockResult({
        id: `${i}`,
        provider: "noosphere",
        content: `Content ${i}`,
        relevanceScore: 1 - i * 0.1,
      }),
    );

    const orchestrator = new RecallOrchestrator({
      providers: [{ provider: mockProvider("noosphere", results) }],
      globalResultCap: 3,
    });

    const response = await orchestrator.recall({
      query: "test",
      mode: "inspection",
    });

    assertEqual(response.results.length, 3, "capped at 3");
    assertEqual(response.totalBeforeCap, 10, "total before cap");
  });

  test("per-query resultCap overrides global", async () => {
    const results = Array.from({ length: 5 }, (_, i) =>
      mockResult({
        id: `${i}`,
        provider: "noosphere",
        content: `Content ${i}`,
        relevanceScore: 1 - i * 0.1,
      }),
    );

    const orchestrator = new RecallOrchestrator({
      providers: [{ provider: mockProvider("noosphere", results) }],
      globalResultCap: 3,
    });

    const response = await orchestrator.recall({
      query: "test",
      mode: "inspection",
      resultCap: 1,
    });

    assertEqual(response.results.length, 1, "query cap overrides global");
  });

  // ─── Token budget (auto mode) ───────────────────────────────────────────

  test("auto mode truncates results to token budget", async () => {
    // Each result is ~30 chars → ~8 tokens at 4 chars/token.
    const results = Array.from({ length: 5 }, (_, i) =>
      mockResult({
        id: `${i}`,
        provider: "noosphere",
        content: `A`.repeat(40),
        relevanceScore: 1 - i * 0.1,
      }),
    );

    const orchestrator = new RecallOrchestrator({
      providers: [{ provider: mockProvider("noosphere", results) }],
      autoRecallTokenBudget: 20, // ~5 results worth → should fit ~2
    });

    const response = await orchestrator.recall({
      query: "test",
      mode: "auto",
    });

    assert(response.results.length < 5, "truncated by budget");
    const tokenBudgetUsed = response.tokenBudgetUsed;
    if (tokenBudgetUsed === undefined) {
      throw new Error("token usage reported");
    }
    assert(tokenBudgetUsed <= 20, "actual usage within budget");
    assert(response.promptInjectionText !== undefined, "has prompt text");
  });

  test("auto mode budgets full content before falling back to summary", async () => {
    const results = [
      mockResult({
        id: "long",
        provider: "noosphere",
        content: "A".repeat(400),
        summary: "short",
        tokenEstimate: 2,
        relevanceScore: 1,
      }),
    ];

    const orchestrator = new RecallOrchestrator({
      providers: [{ provider: mockProvider("noosphere", results) }],
      autoRecallTokenBudget: 10,
    });

    const response = await orchestrator.recall({
      query: "test",
      mode: "auto",
    });

    assertEqual(response.results.length, 1, "summary fallback kept result");
    assertEqual(response.results[0].content, "short", "summary used for output");
    assertEqual(response.tokenBudgetUsed, 2, "actual summary token usage reported");
    assert(!response.promptInjectionText?.includes("AAAA"), "long content omitted");
  });

  // ─── Prompt injection formatting ────────────────────────────────────────

  test("auto mode generates prompt injection XML", async () => {
    const results = [
      mockResult({
        id: "1",
        provider: "noosphere",
        title: "Test Article",
        content: "Hello world",
        canonicalRef: "noosphere:article:1",
        relevanceScore: 0.9,
      }),
    ];

    const orchestrator = new RecallOrchestrator({
      providers: [{ provider: mockProvider("noosphere", results) }],
    });

    const response = await orchestrator.recall({
      query: "test query",
      mode: "auto",
    });

    const xml = response.promptInjectionText!;
    assert(xml.includes('<recall query="test query">'), "recall open tag");
    assert(xml.includes('<memory source="noosphere"'), "memory tag");
    assert(xml.includes('title="Test Article"'), "title attr");
    assert(xml.includes('ref="noosphere:article:1"'), "ref attr");
    assert(xml.includes("Hello world"), "content");
    assert(xml.includes("</recall>"), "recall close tag");
  });

  test("prompt injection escapes XML special characters", async () => {
    const results = [
      mockResult({
        id: "1",
        provider: "noosphere",
        title: 'Test "quotes" & <brackets>',
        content: "Value: 5 > 3 & 2 < 4",
        relevanceScore: 0.9,
      }),
    ];

    const orchestrator = new RecallOrchestrator({
      providers: [{ provider: mockProvider("noosphere", results) }],
    });

    const response = await orchestrator.recall({
      query: 'test "query"',
      mode: "auto",
    });

    const xml = response.promptInjectionText!;
    assert(!xml.includes('"query"'), "query quotes escaped");
    assert(xml.includes("&quot;"), "quote escaped in attr");
    assert(xml.includes("&amp;"), "ampersand escaped");
    assert(xml.includes("&lt;"), "less-than escaped");
    assert(xml.includes("&gt;"), "greater-than escaped");
  });

  test("auto mode returns empty string for no results", async () => {
    const orchestrator = new RecallOrchestrator({
      providers: [{ provider: mockProvider("empty") }],
    });

    const response = await orchestrator.recall({
      query: "test",
      mode: "auto",
    });

    assertEqual(response.promptInjectionText, "", "empty prompt text");
  });

  // ─── Provider duration tracking ─────────────────────────────────────────

  test("tracks per-provider duration", async () => {
    const slowProvider = mockProvider("slow", [], {
      search: async () => {
        await new Promise((r) => setTimeout(r, 10));
        return [
          mockResult({ id: "1", provider: "slow", content: "data" }),
        ];
      },
    });

    const orchestrator = new RecallOrchestrator({
      providers: [{ provider: slowProvider }],
    });

    const response = await orchestrator.recall({
      query: "test",
      mode: "inspection",
    });

    assert(
      response.providerMeta[0].durationMs >= 10,
      "duration tracked (>= 10ms)",
    );
  });

  // ─── Priority weight affects ranking ────────────────────────────────────

  test("higher priority weight boosts ranking", async () => {
    const lowResults = [
      mockResult({
        id: "low",
        provider: "low-priority",
        content: "low priority content",
        relevanceScore: 0.9,
      }),
    ];
    const highResults = [
      mockResult({
        id: "high",
        provider: "high-priority",
        content: "high priority content",
        relevanceScore: 0.5,
      }),
    ];

    const orchestrator = new RecallOrchestrator({
      providers: [
        {
          provider: mockProvider("low-priority", lowResults),
          config: { priorityWeight: 0.5 },
        },
        {
          provider: mockProvider("high-priority", highResults),
          config: { priorityWeight: 2.0 },
        },
      ],
    });

    const response = await orchestrator.recall({
      query: "test",
      mode: "inspection",
    });

    // High priority with weight 2.0 should outrank low priority with weight 0.5
    // even though low has higher relevance (0.9 vs 0.5).
    // Composite: low = 0.9*0.4*0.5 = 0.18, high = 0.5*0.4*2.0 = 0.4
    assertEqual(
      response.results[0].providerId,
      "high-priority",
      "high priority wins",
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
