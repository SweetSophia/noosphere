/**
 * CrossProviderDeduplicator — Unit Tests
 *
 * Run with: DATABASE_URL="postgresql://test:test@localhost:5432/test" npx tsx src/__tests__/memory/dedup.test.ts
 */

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
}

import {
  CrossProviderDeduplicator,
  createDeduplicator,
} from "@/lib/memory/dedup";
import type {
  DeduplicationStrategy,
  ScoredCandidate,
} from "@/lib/memory/dedup";
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

// ─── Mock helpers ────────────────────────────────────────────────────────────

function candidate(
  overrides: Partial<MemoryResult> & {
    id: string;
    provider: string;
    providerId: string;
    compositeScore: number;
  },
): ScoredCandidate {
  return {
    result: {
      sourceType: "noosphere" as MemoryResult["sourceType"],
      content: `Content for ${overrides.id}`,
      ...overrides,
    },
    providerId: overrides.providerId,
    compositeScore: overrides.compositeScore,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🔍 CrossProviderDeduplicator Tests\n");

  // ─── Constructor & defaults ────────────────────────────────────────────

  test("constructor applies default strategy", () => {
    const dedup = new CrossProviderDeduplicator();
    assertEqual(dedup["strategy"], "best-score", "default strategy");
  });

  test("constructor respects custom config", () => {
    const dedup = new CrossProviderDeduplicator({
      strategy: "provider-priority",
      providerPriority: ["noosphere", "hindsight"],
    });
    assertEqual(dedup["strategy"], "provider-priority", "custom strategy");
    assertEqual(dedup["providerPriority"].length, 2, "priority list set");
  });

  test("factory returns instance", () => {
    const dedup = createDeduplicator({ strategy: "most-recent" });
    assert(dedup instanceof CrossProviderDeduplicator, "factory instance");
  });

  // ─── No duplicates ────────────────────────────────────────────────────

  test("passes through unique results unchanged", () => {
    const dedup = new CrossProviderDeduplicator();
    const entries = [
      candidate({ id: "1", provider: "a", providerId: "a", compositeScore: 0.9, canonicalRef: "ref-1" }),
      candidate({ id: "2", provider: "a", providerId: "a", compositeScore: 0.8, canonicalRef: "ref-2" }),
    ];

    const result = dedup.dedup(entries);
    assertEqual(result.results.length, 2, "both results kept");
    assertEqual(result.stats.totalInput, 2, "input count");
    assertEqual(result.stats.totalOutput, 2, "output count");
    assertEqual(result.stats.collapsedTotal, 0, "nothing collapsed");
  });

  test("entries without canonicalRef dedup by providerId:id fallback", () => {
    const dedup = new CrossProviderDeduplicator();
    // Same provider + same id → should collapse (same fallback key)
    const entries = [
      candidate({ id: "1", provider: "a", providerId: "a", compositeScore: 0.9 }),
      candidate({ id: "1", provider: "a", providerId: "a", compositeScore: 0.8 }),
    ];

    const result = dedup.dedup(entries);
    assertEqual(result.results.length, 1, "collapsed by fallback key");
    assertEqual(result.stats.collapsedTotal, 1, "1 collapsed");
  });

  test("entries without canonicalRef with different ids stay separate", () => {
    const dedup = new CrossProviderDeduplicator();
    const entries = [
      candidate({ id: "1", provider: "a", providerId: "a", compositeScore: 0.9 }),
      candidate({ id: "2", provider: "a", providerId: "a", compositeScore: 0.8 }),
    ];

    const result = dedup.dedup(entries);
    assertEqual(result.results.length, 2, "different ids → different fallback keys");
    assertEqual(result.stats.collapsedTotal, 0, "nothing collapsed");
  });

  test("handles empty input", () => {
    const dedup = new CrossProviderDeduplicator();
    const result = dedup.dedup([]);
    assertEqual(result.results.length, 0, "empty output");
    assertEqual(result.stats.collapsedTotal, 0, "nothing collapsed");
  });

  // ─── Best-score strategy ──────────────────────────────────────────────

  test("best-score keeps highest composite score", () => {
    const dedup = new CrossProviderDeduplicator({ strategy: "best-score" });
    const entries = [
      candidate({ id: "1", provider: "a", providerId: "a", compositeScore: 0.5, canonicalRef: "shared-ref" }),
      candidate({ id: "2", provider: "b", providerId: "b", compositeScore: 0.9, canonicalRef: "shared-ref" }),
    ];

    const result = dedup.dedup(entries);
    assertEqual(result.results.length, 1, "collapsed to one");
    assertEqual(result.results[0].result.id, "2", "kept higher score");
    assertEqual(result.results[0].collapsedCount, 1, "1 collapsed");
    assertEqual(result.stats.collapsedTotal, 1, "stats match");
  });

  test("best-score preserves full provenance", () => {
    const dedup = new CrossProviderDeduplicator({ strategy: "best-score" });
    const entries = [
      candidate({ id: "1", provider: "a", providerId: "a", compositeScore: 0.5, canonicalRef: "shared-ref", relevanceScore: 0.4 }),
      candidate({ id: "2", provider: "b", providerId: "b", compositeScore: 0.9, canonicalRef: "shared-ref", relevanceScore: 0.8 }),
    ];

    const result = dedup.dedup(entries);
    assertEqual(result.results[0].provenance.length, 2, "both providers in provenance");
    assertEqual(result.results[0].provenance[0].providerId, "a", "first provider");
    assertEqual(result.results[0].provenance[1].providerId, "b", "second provider");
    assertEqual(result.results[0].provenance[1].localId, "2", "local id preserved");
  });

  // ─── Provider-priority strategy ───────────────────────────────────────

  test("provider-priority keeps result from highest-priority provider", () => {
    const dedup = new CrossProviderDeduplicator({
      strategy: "provider-priority",
      providerPriority: ["noosphere", "hindsight"],
    });

    const entries = [
      candidate({ id: "1", provider: "hindsight", providerId: "hindsight", compositeScore: 0.9, canonicalRef: "shared-ref" }),
      candidate({ id: "2", provider: "noosphere", providerId: "noosphere", compositeScore: 0.5, canonicalRef: "shared-ref" }),
    ];

    const result = dedup.dedup(entries);
    assertEqual(result.results.length, 1, "collapsed to one");
    assertEqual(result.results[0].result.id, "2", "kept higher priority provider");
  });

  test("provider-priority falls back to score for same provider", () => {
    const dedup = new CrossProviderDeduplicator({
      strategy: "provider-priority",
      providerPriority: ["noosphere"],
    });

    const entries = [
      candidate({ id: "1", provider: "other", providerId: "other", compositeScore: 0.3, canonicalRef: "shared-ref" }),
      candidate({ id: "2", provider: "other2", providerId: "other2", compositeScore: 0.9, canonicalRef: "shared-ref" }),
    ];

    const result = dedup.dedup(entries);
    assertEqual(result.results[0].result.id, "2", "kept higher score (neither in priority list)");
  });

  test("provider-priority with empty list falls back to best-score", () => {
    const dedup = new CrossProviderDeduplicator({
      strategy: "provider-priority",
    });

    const entries = [
      candidate({ id: "1", provider: "a", providerId: "a", compositeScore: 0.3, canonicalRef: "shared-ref" }),
      candidate({ id: "2", provider: "b", providerId: "b", compositeScore: 0.9, canonicalRef: "shared-ref" }),
    ];

    const result = dedup.dedup(entries);
    assertEqual(result.results[0].result.id, "2", "fell back to best-score");
  });

  // ─── Most-recent strategy ─────────────────────────────────────────────

  test("most-recent keeps result with latest updatedAt", () => {
    const dedup = new CrossProviderDeduplicator({ strategy: "most-recent" });

    const entries = [
      candidate({ id: "1", provider: "a", providerId: "a", compositeScore: 0.9, canonicalRef: "shared-ref", updatedAt: "2026-01-01T00:00:00Z" }),
      candidate({ id: "2", provider: "b", providerId: "b", compositeScore: 0.5, canonicalRef: "shared-ref", updatedAt: "2026-04-01T00:00:00Z" }),
    ];

    const result = dedup.dedup(entries);
    assertEqual(result.results[0].result.id, "2", "kept most recent");
  });

  test("most-recent falls back to createdAt when updatedAt is missing", () => {
    const dedup = new CrossProviderDeduplicator({ strategy: "most-recent" });

    const entries = [
      candidate({ id: "1", provider: "a", providerId: "a", compositeScore: 0.9, canonicalRef: "shared-ref", createdAt: "2026-04-01T00:00:00Z" }),
      candidate({ id: "2", provider: "b", providerId: "b", compositeScore: 0.5, canonicalRef: "shared-ref", createdAt: "2026-01-01T00:00:00Z" }),
    ];

    const result = dedup.dedup(entries);
    assertEqual(result.results[0].result.id, "1", "kept more recent createdAt");
  });

  test("most-recent tiebreaks on composite score", () => {
    const dedup = new CrossProviderDeduplicator({ strategy: "most-recent" });

    const entries = [
      candidate({ id: "1", provider: "a", providerId: "a", compositeScore: 0.5, canonicalRef: "shared-ref", updatedAt: "2026-01-01T00:00:00Z" }),
      candidate({ id: "2", provider: "b", providerId: "b", compositeScore: 0.9, canonicalRef: "shared-ref", updatedAt: "2026-01-01T00:00:00Z" }),
    ];

    const result = dedup.dedup(entries);
    assertEqual(result.results[0].result.id, "2", "tiebreak on score");
  });

  // ─── Multiple groups ──────────────────────────────────────────────────

  test("DeduplicatedResult includes winner providerId and compositeScore", () => {
    const dedup = new CrossProviderDeduplicator({ strategy: "most-recent" });
    const entries = [
      candidate({ id: "1", provider: "a", providerId: "a", compositeScore: 0.9, canonicalRef: "shared-ref", updatedAt: "2026-01-01T00:00:00Z" }),
      candidate({ id: "2", provider: "b", providerId: "b", compositeScore: 0.3, canonicalRef: "shared-ref", updatedAt: "2026-06-01T00:00:00Z" }),
    ];

    const result = dedup.dedup(entries);
    assertEqual(result.results[0].providerId, "b", "winner providerId");
    assertEqual(result.results[0].compositeScore, 0.3, "winner compositeScore");
  });

  test("multiple dedup groups independently report collapsed counts", () => {
    const dedup = new CrossProviderDeduplicator();
    const entries = [
      candidate({ id: "1", provider: "a", providerId: "a", compositeScore: 0.9, canonicalRef: "ref-a" }),
      candidate({ id: "2", provider: "b", providerId: "b", compositeScore: 0.8, canonicalRef: "ref-a" }),
      candidate({ id: "3", provider: "a", providerId: "a", compositeScore: 0.7, canonicalRef: "ref-b" }),
      candidate({ id: "4", provider: "b", providerId: "b", compositeScore: 0.95, canonicalRef: "ref-b" }),
    ];

    const result = dedup.dedup(entries);
    assertEqual(result.results.length, 2, "two groups → two results");
    assertEqual(result.results[0].result.id, "1", "ref-a winner");
    assertEqual(result.results[1].result.id, "4", "ref-b winner");
    assertEqual(result.stats.collapsedTotal, 2, "2 total collapsed");
  });

  // ─── All strategies are valid ─────────────────────────────────────────

  const strategies: DeduplicationStrategy[] = ["best-score", "provider-priority", "most-recent"];
  for (const s of strategies) {
    test(`strategy "${s}" is accepted`, () => {
      const dedup = new CrossProviderDeduplicator({ strategy: s });
      assertEqual(dedup["strategy"], s, `strategy set to ${s}`);
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
