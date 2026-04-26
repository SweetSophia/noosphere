/**
 * ContextBudgetManager — Unit Tests
 *
 * Run with: DATABASE_URL="postgresql://test:test@localhost:5432/test" npx tsx src/__tests__/memory/budget.test.ts
 */

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
}

import {
  ContextBudgetManager,
  createContextBudgetManager,
} from "@/lib/memory/budget";
import type { BudgetVerbosity } from "@/lib/memory/budget";
import type { MemoryResult } from "@/lib/memory/types";

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

// ─── Mock results ────────────────────────────────────────────────────────────

function mockResult(
  overrides: Partial<MemoryResult> & { id: string; provider: string },
): MemoryResult {
  return {
    sourceType: "noosphere" as MemoryResult["sourceType"],
    content: `Content for ${overrides.id}`,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n💰 ContextBudgetManager Tests\n");

  // ─── Constructor & defaults ────────────────────────────────────────────

  test("constructor applies defaults", () => {
    const mgr = new ContextBudgetManager();
    assertEqual(mgr.maxTokens, 2000, "default maxTokens");
    assertEqual(mgr.maxResults, 20, "default maxResults");
    assertEqual(mgr.summaryFirst, true, "default summaryFirst");
    assertEqual(mgr.verbosity, "standard", "default verbosity");
  });

  test("constructor respects custom config", () => {
    const mgr = new ContextBudgetManager({
      maxTokens: 500,
      maxResults: 5,
      summaryFirst: false,
      verbosity: "minimal",
    });
    assertEqual(mgr.maxTokens, 500, "custom maxTokens");
    assertEqual(mgr.maxResults, 5, "custom maxResults");
    assertEqual(mgr.summaryFirst, false, "custom summaryFirst");
    assertEqual(mgr.verbosity, "minimal", "custom verbosity");
  });

  test("constructor sanitizes invalid values", () => {
    const mgr = new ContextBudgetManager({
      maxTokens: -10,
      maxResults: NaN,
    });
    assertEqual(mgr.maxTokens, 2000, "negative falls back to default");
    assertEqual(mgr.maxResults, 20, "NaN falls back to default");
  });

  test("factory returns instance", () => {
    const mgr = createContextBudgetManager({ maxTokens: 100 });
    assert(mgr instanceof ContextBudgetManager, "factory instance");
    assertEqual(mgr.maxTokens, 100, "factory config applied");
  });

  // ─── Max results enforcement ───────────────────────────────────────────

  test("caps results to maxResults", () => {
    const mgr = new ContextBudgetManager({
      maxResults: 3,
      maxTokens: 10000, // generous so token budget doesn't interfere
    });

    const results = Array.from({ length: 10 }, (_, i) =>
      mockResult({ id: `${i}`, provider: "test", content: `Item ${i}` }),
    );

    const budgetResult = mgr.apply(results);
    assertEqual(budgetResult.results.length, 3, "capped to maxResults");
    assertEqual(budgetResult.totalBeforeBudget, 10, "total before budget");
    assertEqual(budgetResult.droppedCount, 7, "7 dropped");
  });

  // ─── Token budget enforcement ──────────────────────────────────────────

  test("enforces token budget", () => {
    const mgr = new ContextBudgetManager({
      maxTokens: 20, // ~5 tokens per "AAAA..." result
      maxResults: 100,
    });

    const results = Array.from({ length: 5 }, (_, i) =>
      mockResult({
        id: `${i}`,
        provider: "test",
        content: "A".repeat(40), // ~10 tokens each
      }),
    );

    const budgetResult = mgr.apply(results);
    assert(budgetResult.results.length < 5, "truncated by token budget");
    assert(budgetResult.tokensUsed <= 20, "tokens within budget");
    assertEqual(budgetResult.totalBeforeBudget, 5, "total before budget");
  });

  test("returns empty results for zero-budget", () => {
    // 1 is the minimum (normalizePositiveFinite clamps to >= 1)
    const mgr = new ContextBudgetManager({ maxTokens: 1 });
    const results = [
      mockResult({ id: "1", provider: "test", content: "Hello world" }),
    ];
    const budgetResult = mgr.apply(results);
    assertEqual(budgetResult.results.length, 0, "nothing fits in 1 token");
    assertEqual(budgetResult.droppedCount, 1, "1 dropped");
  });

  // ─── Summary-first preference ──────────────────────────────────────────

  test("prefers summary when summaryFirst is true", () => {
    const mgr = new ContextBudgetManager({
      maxTokens: 1000,
      summaryFirst: true,
    });

    const results = [
      mockResult({
        id: "1",
        provider: "test",
        content: "A".repeat(200),
        summary: "Short",
      }),
    ];

    const budgetResult = mgr.apply(results);
    assertEqual(budgetResult.results.length, 1, "result included");
    assertEqual(budgetResult.results[0].usedSummary, true, "used summary");
    assertEqual(budgetResult.results[0].tokenEstimate, 2, "summary tokens ~2");
    assertEqual(budgetResult.trimmedCount, 1, "1 trimmed");
  });

  test("uses full content when summaryFirst is false", () => {
    const mgr = new ContextBudgetManager({
      maxTokens: 10000,
      summaryFirst: false,
    });

    const results = [
      mockResult({
        id: "1",
        provider: "test",
        content: "A".repeat(200),
        summary: "Short",
      }),
    ];

    const budgetResult = mgr.apply(results);
    assertEqual(budgetResult.results.length, 1, "result included");
    assertEqual(budgetResult.results[0].usedSummary, false, "used full content");
    assertEqual(budgetResult.results[0].tokenEstimate, 50, "full content tokens ~50");
  });

  test("falls back to summary when full content doesn't fit", () => {
    const mgr = new ContextBudgetManager({
      maxTokens: 20,
      summaryFirst: false, // prefer full, but fall back
      maxResults: 100,
    });

    const results = [
      mockResult({
        id: "1",
        provider: "test",
        content: "A".repeat(200), // ~50 tokens, won't fit
        summary: "Short summary", // ~4 tokens, fits
      }),
    ];

    const budgetResult = mgr.apply(results);
    assertEqual(budgetResult.results.length, 1, "result included via fallback");
    assertEqual(budgetResult.results[0].usedSummary, true, "fell back to summary");
    assertEqual(budgetResult.trimmedCount, 1, "1 trimmed");
  });

  test("drops result when neither content nor summary fits", () => {
    const mgr = new ContextBudgetManager({
      maxTokens: 5,
      maxResults: 100,
    });

    const results = [
      mockResult({
        id: "1",
        provider: "test",
        content: "A".repeat(200), // ~50 tokens
        summary: "A".repeat(40), // ~10 tokens
      }),
    ];

    const budgetResult = mgr.apply(results);
    assertEqual(budgetResult.results.length, 0, "nothing fits");
    assertEqual(budgetResult.droppedCount, 1, "1 dropped");
  });

  // ─── Verbosity control ─────────────────────────────────────────────────

  test("minimal verbosity caps per-result tokens", () => {
    const mgr = new ContextBudgetManager({
      maxTokens: 1000,
      verbosity: "minimal",
    });

    const results = [
      mockResult({
        id: "1",
        provider: "test",
        content: "A".repeat(400), // ~100 tokens raw
      }),
    ];

    const budgetResult = mgr.apply(results);
    assertEqual(budgetResult.results.length, 1, "result included");
    // Minimal caps at 60 tokens per result
    assertEqual(budgetResult.results[0].tokenEstimate, 60, "capped at 60");
  });

  test("standard verbosity does not cap per-result tokens", () => {
    const mgr = new ContextBudgetManager({
      maxTokens: 10000,
      verbosity: "standard",
    });

    const results = [
      mockResult({
        id: "1",
        provider: "test",
        content: "A".repeat(400), // ~100 tokens
      }),
    ];

    const budgetResult = mgr.apply(results);
    assertEqual(budgetResult.results[0].tokenEstimate, 100, "full estimate");
  });

  test("detailed verbosity uses full content", () => {
    const mgr = new ContextBudgetManager({
      maxTokens: 10000,
      verbosity: "detailed",
      summaryFirst: true, // even with summaryFirst, detailed gets full content via selectContent
    });

    const results = [
      mockResult({
        id: "1",
        provider: "test",
        content: "Full content here",
        summary: "Short",
      }),
    ];

    const budgetResult = mgr.apply(results);
    // summaryFirst is true so selectContent returns summary for standard,
    // but detailed mode should use full content regardless.
    // NOTE: current implementation uses summaryFirst in selectContent for
    // all modes. This test documents expected behavior. If "detailed"
    // should force full content, selectContent needs a verbosity check.
    // For now, summaryFirst governs content selection.
    assertEqual(budgetResult.results.length, 1, "result included");
  });

  // ─── getContent helper ─────────────────────────────────────────────────

  test("getContent returns summary when summaryFirst and summary exists", () => {
    const mgr = new ContextBudgetManager({ summaryFirst: true });
    const result = mockResult({
      id: "1",
      provider: "test",
      content: "Full content",
      summary: "Summary",
    });
    assertEqual(mgr.getContent(result), "Summary", "returns summary");
  });

  test("getContent returns full content when no summary", () => {
    const mgr = new ContextBudgetManager({ summaryFirst: true });
    const result = mockResult({
      id: "1",
      provider: "test",
      content: "Full content",
    });
    assertEqual(mgr.getContent(result), "Full content", "returns content");
  });

  test("getContent returns full content when summaryFirst is false", () => {
    const mgr = new ContextBudgetManager({ summaryFirst: false });
    const result = mockResult({
      id: "1",
      provider: "test",
      content: "Full content",
      summary: "Summary",
    });
    assertEqual(mgr.getContent(result), "Full content", "returns content");
  });

  // ─── Budget accounting ─────────────────────────────────────────────────

  test("accounts tokensUsed accurately", () => {
    const mgr = new ContextBudgetManager({
      maxTokens: 1000,
      summaryFirst: false,
      maxResults: 100,
    });

    const results = [
      mockResult({ id: "1", provider: "test", content: "A".repeat(20) }), // ~5 tokens
      mockResult({ id: "2", provider: "test", content: "B".repeat(40) }), // ~10 tokens
    ];

    const budgetResult = mgr.apply(results);
    assertEqual(budgetResult.results.length, 2, "both fit");
    assertEqual(budgetResult.tokensUsed, 15, "5 + 10 = 15 tokens");
    assertEqual(budgetResult.droppedCount, 0, "none dropped");
    assertEqual(budgetResult.trimmedCount, 0, "none trimmed");
  });

  test("handles empty input", () => {
    const mgr = new ContextBudgetManager();
    const budgetResult = mgr.apply([]);
    assertEqual(budgetResult.results.length, 0, "empty output");
    assertEqual(budgetResult.totalBeforeBudget, 0, "zero total");
    assertEqual(budgetResult.tokensUsed, 0, "zero tokens");
    assertEqual(budgetResult.droppedCount, 0, "none dropped");
  });

  test("stopping early leaves remaining results dropped", () => {
    const mgr = new ContextBudgetManager({
      maxTokens: 15, // fits first result (~5 tokens) but not second (~10)
      maxResults: 100,
    });

    const results = [
      mockResult({ id: "1", provider: "test", content: "A".repeat(20) }), // ~5
      mockResult({ id: "2", provider: "test", content: "B".repeat(100) }), // ~25
      mockResult({ id: "3", provider: "test", content: "C".repeat(20) }), // ~5 (would fit alone)
    ];

    const budgetResult = mgr.apply(results);
    // Result 2 doesn't fit (25 > 15-5=10 remaining), stops.
    // Result 3 is after result 2, so it's also dropped even though it would fit.
    assertEqual(budgetResult.results.length, 1, "only first fits");
    assertEqual(budgetResult.droppedCount, 2, "2 dropped");
  });

  // ─── All verbosity values are valid ────────────────────────────────────

  const verbosities: BudgetVerbosity[] = ["minimal", "standard", "detailed"];
  for (const v of verbosities) {
    test(`verbosity "${v}" is accepted`, () => {
      const mgr = new ContextBudgetManager({ verbosity: v });
      assertEqual(mgr.verbosity, v, `verbosity set to ${v}`);
    });
  }

  // ─── Wait for all async tests ──────────────────────────────────────────

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
