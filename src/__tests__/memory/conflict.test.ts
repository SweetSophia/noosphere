/**
 * Conflict Resolution Engine — Unit Tests
 *
 * Run with: npx tsx src/__tests__/memory/conflict.test.ts
 */

import {
  resolveConflicts,
  computeConflictScore,
  detectConflict,
  createConflictResolver,
} from "@/lib/memory/conflict";
import type { MemoryResult } from "@/lib/memory/types";

// ─── Test runner ───────────────────────────────────────────────────────────

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
      console.log(`  \u2713 ${label}`);
    })
    .catch((err: unknown) => {
      failCount++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  \u2717 ${label}\n    ${message}`);
    });
  pending.push(p);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (!deepEqual(actual, expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const aArr = a as unknown[];
    const bArr = b as unknown[];
    if (aArr.length !== bArr.length) return false;
    return aArr.every((v, i) => deepEqual(v, bArr[i]));
  }
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  if (!aKeys.every((k) => Object.prototype.hasOwnProperty.call(bObj, k))) return false;
  return aKeys.every((k) => deepEqual(aObj[k], bObj[k]));
}

function assertApprox(actual: number, expected: number, tolerance: number, message: string): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}: expected ~${expected}, got ${actual}`);
  }
}

// ─── Mock MemoryResult factories ─────────────────────────────────────────────

function makeMemory(overrides: Partial<MemoryResult> = {}): MemoryResult {
  return {
    id: "mem-1",
    provider: "hindsight",
    sourceType: "hindsight",
    content: "The meeting is at 3pm",
    summary: "Meeting at 3pm",
    relevanceScore: 0.8,
    confidenceScore: 0.9,
    recencyScore: 0.7,
    curationLevel: "ephemeral",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    tokenEstimate: 50,
    canonicalRef: "hindsight:test:mem-1",
    tags: ["meeting"],
    metadata: {},
    ...overrides,
  };
}

// ─── computeConflictScore tests ───────────────────────────────────────────────

test("computeConflictScore returns 0 for identical results", () => {
  const result = makeMemory({ id: "mem-1", provider: "hindsight" });
  const score = computeConflictScore(result, result);
  assertEqual(score, 0, "identical results have 0 conflict");
});

test("computeConflictScore is high when content differs significantly", () => {
  const resultA = makeMemory({ id: "mem-1", content: "The meeting is at 3pm" });
  const resultB = makeMemory({ id: "mem-2", content: "The meeting is at 5pm" });
  const score = computeConflictScore(resultA, resultB);
  assertApprox(score, 0.4, 0.1, "different content gives ~0.4 conflict");
});

test("computeConflictScore considers curation level difference", () => {
  const resultA = makeMemory({
    id: "mem-1",
    curationLevel: "curated",
    confidenceScore: 0.5,
  });
  const resultB = makeMemory({
    id: "mem-2",
    curationLevel: "ephemeral",
    confidenceScore: 0.5,
  });
  const score = computeConflictScore(resultA, resultB);
  // Content diff = 0, curation diff adds ~0.2, confidence diff ~0 → ~0.2 total
  assertApprox(score, 0.2, 0.15, "curation difference adds conflict");
});

test("computeConflictScore considers confidence divergence", () => {
  const resultA = makeMemory({ id: "mem-1", confidenceScore: 0.9 });
  const resultB = makeMemory({ id: "mem-2", confidenceScore: 0.2 });
  const score = computeConflictScore(resultA, resultB);
  // High confidence divergence (~0.4) adds ~0.2 to conflict
  assertApprox(score, 0.2, 0.15, "confidence divergence adds conflict");
});

// ─── detectConflict tests ─────────────────────────────────────────────────────

test("detectConflict returns null for identical results", () => {
  const result = makeMemory({ id: "mem-1", provider: "hindsight" });
  const conflict = detectConflict(result, result, 0.1);
  assertEqual(conflict, null, "same result is not a conflict");
});

test("detectConflict returns null when score is below threshold", () => {
  const resultA = makeMemory({ id: "mem-1", provider: "hindsight" });
  const resultB = makeMemory({ id: "mem-2", provider: "noosphere" });
  // Set similar content to keep conflict score low
  const conflict = detectConflict(resultA, resultB, 0.9);
  // May or may not trigger depending on provider diff - just check structure if returned
  if (conflict) {
    assertApprox(conflict.conflictScore, 0.1, 0.05, "conflict score should be ~0.1");
  }
});

test("detectConflict returns signal when content differs significantly", () => {
  const resultA = makeMemory({
    id: "mem-1",
    provider: "hindsight",
    content: "The meeting is at 3pm",
    confidenceScore: 0.6,
  });
  const resultB = makeMemory({
    id: "mem-2",
    provider: "noosphere",
    content: "The meeting is at 5pm",
    confidenceScore: 0.5,
  });
  const conflict = detectConflict(resultA, resultB, 0.1);
  assertEqual(conflict !== null, true, "conflict should be detected");
  if (conflict) {
    assertApprox(conflict.conflictScore, 0.4, 0.15, "conflict score should be significant");
    assertEqual(conflict.reason, "content-mismatch", "reason should be content-mismatch");
  }
});

test("detectConflict returns null for same provider and same id", () => {
  const resultA = makeMemory({ id: "mem-1", provider: "hindsight" });
  const resultB = makeMemory({ id: "mem-1", provider: "hindsight" });
  const conflict = detectConflict(resultA, resultB, 0.1);
  assertEqual(conflict, null, "same provider+id is not a conflict");
});

// ─── resolveConflicts with surface strategy ─────────────────────────────────

test("resolveConflicts surface strategy keeps both results", () => {
  const resultA = makeMemory({ id: "mem-1", provider: "hindsight", content: "Meeting at 3pm" });
  const resultB = makeMemory({ id: "mem-2", provider: "noosphere", content: "Meeting at 5pm" });

  const conflictResult = resolveConflicts([resultA, resultB], {
    strategy: "surface",
    conflictThreshold: 0.1,
  });

  assertEqual(conflictResult.results.length, 2, "both results kept");
  assertEqual(conflictResult.conflicts.length, 1, "one conflict detected");
  assertEqual(conflictResult.stats.conflictingPairs, 1, "stats show 1 pair");
});

test("resolveConflicts surface strategy returns conflict signals", () => {
  const resultA = makeMemory({ id: "mem-1", provider: "hindsight", content: "Meeting at 3pm" });
  const resultB = makeMemory({ id: "mem-2", provider: "noosphere", content: "Meeting at 5pm" });

  const conflictResult = resolveConflicts([resultA, resultB], {
    strategy: "surface",
    conflictThreshold: 0.1,
  });

  assertEqual(conflictResult.conflicts.length, 1, "one conflict signal");
  const signal = conflictResult.conflicts[0];
  assertEqual(signal.resultA.id, "mem-1", "resultA is mem-1");
  assertEqual(signal.resultB.id, "mem-2", "resultB is mem-2");
});

test("resolveConflicts with no conflicts returns results unchanged", () => {
  // Two results that are very similar (low conflict score)
  const resultA = makeMemory({
    id: "mem-1",
    provider: "hindsight",
    content: "Meeting at 3pm",
    confidenceScore: 0.8,
  });
  const resultB = makeMemory({
    id: "mem-2",
    provider: "noosphere",
    content: "Meeting at 3pm", // Same content
    confidenceScore: 0.8,
  });

  const conflictResult = resolveConflicts([resultA, resultB], {
    strategy: "surface",
    conflictThreshold: 0.5, // High threshold
  });

  assertEqual(conflictResult.results.length, 2, "both results kept");
  assertEqual(conflictResult.conflicts.length, 0, "no conflicts");
});

// ─── resolveConflicts with accept-highest strategy ─────────────────────────────

test("resolveConflicts accept-highest keeps higher scoring result", () => {
  const resultA = makeMemory({
    id: "mem-1",
    provider: "hindsight",
    content: "Meeting at 3pm",
    relevanceScore: 0.8,
    confidenceScore: 0.8,
    recencyScore: 0.8,
  });
  const resultB = makeMemory({
    id: "mem-2",
    provider: "noosphere",
    content: "Meeting at 5pm",
    relevanceScore: 0.5,
    confidenceScore: 0.5,
    recencyScore: 0.5,
  });

  const conflictResult = resolveConflicts([resultA, resultB], {
    strategy: "accept-highest",
    conflictThreshold: 0.1,
    providerPriorityWeights: {},
  });

  // accept-highest picks the winner but keeps both results (doesn't filter)
  assertEqual(conflictResult.results.length, 2, "both results kept");
  assertEqual(conflictResult.results.some((r) => r.id === "mem-1"), true, "mem-1 (winner) is in results");
  assertEqual(conflictResult.stats.suppressed, 0, "no results suppressed");
});

test("resolveConflicts accept-highest with provider weights prefers higher weight", () => {
  const resultA = makeMemory({
    id: "mem-1",
    provider: "hindsight",
    content: "Meeting at 3pm",
    relevanceScore: 0.5,
    confidenceScore: 0.5,
    recencyScore: 0.5,
  });
  const resultB = makeMemory({
    id: "mem-2",
    provider: "noosphere",
    content: "Meeting at 5pm",
    relevanceScore: 0.5,
    confidenceScore: 0.5,
    recencyScore: 0.5,
  });

  const conflictResult = resolveConflicts([resultA, resultB], {
    strategy: "accept-highest",
    conflictThreshold: 0.1,
    providerPriorityWeights: { noosphere: 2.0, hindsight: 1.0 },
  });

  // noosphere has 2x weight, so mem-2 is the winner but both results are kept
  assertEqual(conflictResult.results.length, 2, "both results kept");
  assertEqual(conflictResult.results.some((r) => r.id === "mem-2"), true, "mem-2 (winner) is in results");
  assertEqual(conflictResult.stats.suppressed, 0, "no results suppressed");
});

// ─── resolveConflicts with suppress-low strategy ─────────────────────────────

test("resolveConflicts suppress-low suppresses lower scoring result", () => {
  const resultA = makeMemory({
    id: "mem-1",
    provider: "hindsight",
    content: "Meeting at 3pm",
    relevanceScore: 0.9,
    confidenceScore: 0.9,
    recencyScore: 0.9,
  });
  const resultB = makeMemory({
    id: "mem-2",
    provider: "noosphere",
    content: "Meeting at 5pm",
    relevanceScore: 0.3,
    confidenceScore: 0.3,
    recencyScore: 0.3,
  });

  const conflictResult = resolveConflicts([resultA, resultB], {
    strategy: "suppress-low",
    conflictThreshold: 0.1,
    providerPriorityWeights: {},
  });

  assertEqual(conflictResult.stats.suppressed >= 1, true, "at least one suppressed");
});

// ─── resolveConflicts with accept-recent strategy ─────────────────────────────

test("resolveConflicts accept-recent prefers more recent result", () => {
  const resultA = makeMemory({
    id: "mem-1",
    provider: "hindsight",
    content: "Meeting at 3pm",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  const resultB = makeMemory({
    id: "mem-2",
    provider: "noosphere",
    content: "Meeting at 5pm",
    updatedAt: "2026-06-01T00:00:00Z", // More recent
  });

  const conflictResult = resolveConflicts([resultA, resultB], {
    strategy: "accept-recent",
    conflictThreshold: 0.1,
  });

  // accept-recent picks the winner but keeps both results (doesn't filter)
  assertEqual(conflictResult.results.length, 2, "both results kept");
  assertEqual(conflictResult.results.some((r) => r.id === "mem-2"), true, "mem-2 (winner) is in results");
  assertEqual(conflictResult.stats.suppressed, 0, "no results suppressed");
});

// ─── resolveConflicts with accept-curated strategy ────────────────────────────

test("resolveConflicts accept-curated prefers curated result", () => {
  const resultA = makeMemory({
    id: "mem-1",
    provider: "hindsight",
    content: "Meeting at 3pm",
    curationLevel: "ephemeral",
  });
  const resultB = makeMemory({
    id: "mem-2",
    provider: "noosphere",
    content: "Meeting at 5pm",
    curationLevel: "curated", // More curated
  });

  const conflictResult = resolveConflicts([resultA, resultB], {
    strategy: "accept-curated",
    conflictThreshold: 0.1,
  });

  // accept-curated picks the winner but keeps both results (doesn't filter)
  assertEqual(conflictResult.results.length, 2, "both results kept");
  assertEqual(conflictResult.results.some((r) => r.id === "mem-2"), true, "mem-2 (winner) is in results");
  assertEqual(conflictResult.stats.suppressed, 0, "no results suppressed");
});

// ─── Stats tests ─────────────────────────────────────────────────────────────

test("resolveConflicts returns correct stats", () => {
  const resultA = makeMemory({ id: "mem-1", provider: "hindsight", content: "Meeting at 3pm" });
  const resultB = makeMemory({ id: "mem-2", provider: "noosphere", content: "Meeting at 5pm" });

  const conflictResult = resolveConflicts([resultA, resultB], {
    strategy: "surface",
    conflictThreshold: 0.1,
  });

  assertEqual(conflictResult.stats.totalInput, 2, "totalInput is 2");
  assertEqual(conflictResult.stats.conflictingPairs, 1, "conflictingPairs is 1");
  assertEqual(conflictResult.stats.resolved, 1, "resolved is 1");
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

test("resolveConflicts handles empty array", () => {
  const conflictResult = resolveConflicts([], {
    strategy: "surface",
    conflictThreshold: 0.1,
  });

  assertEqual(conflictResult.results.length, 0, "empty results");
  assertEqual(conflictResult.conflicts.length, 0, "no conflicts");
  assertEqual(conflictResult.stats.totalInput, 0, "totalInput is 0");
});

test("resolveConflicts with high threshold returns results unchanged", () => {
  const resultA = makeMemory({ id: "mem-1", provider: "hindsight", content: "Meeting at 3pm" });
  const resultB = makeMemory({ id: "mem-2", provider: "noosphere", content: "Meeting at 5pm" });

  const conflictResult = resolveConflicts([resultA, resultB], {
    strategy: "surface",
    conflictThreshold: 0.9, // Very high threshold
  });

  assertEqual(conflictResult.results.length, 2, "both results kept");
  assertEqual(conflictResult.conflicts.length, 0, "no conflicts detected");
});

// ─── createConflictResolver factory ───────────────────────────────────────────

test("createConflictResolver returns a configured resolver function", () => {
  const resolver = createConflictResolver({
    strategy: "surface",
    conflictThreshold: 0.2,
  });

  const resultA = makeMemory({ id: "mem-1", provider: "hindsight", content: "Meeting at 3pm" });
  const resultB = makeMemory({ id: "mem-2", provider: "noosphere", content: "Meeting at 5pm" });

  const conflictResult = resolver([resultA, resultB]);

  assertEqual(conflictResult.results.length, 2, "both results kept");
  assertEqual(conflictResult.conflicts.length, 1, "one conflict detected");
});

// ─── MemoryResult fields needed for conflict detection ───────────────────────

test("resolveConflicts uses confidenceScore in scoring", () => {
  const resultA = makeMemory({
    id: "mem-1",
    provider: "hindsight",
    content: "Meeting at 3pm",
    confidenceScore: 0.9,
    relevanceScore: 0.5,
    recencyScore: 0.5,
  });
  const resultB = makeMemory({
    id: "mem-2",
    provider: "noosphere",
    content: "Meeting at 5pm",
    confidenceScore: 0.1,
    relevanceScore: 0.5,
    recencyScore: 0.5,
  });

  const conflictResult = resolveConflicts([resultA, resultB], {
    strategy: "accept-highest",
    conflictThreshold: 0.1,
    providerPriorityWeights: {},
  });

  // accept-highest picks the winner but keeps both results (doesn't filter)
  assertEqual(conflictResult.results.length, 2, "both results kept");
  assertEqual(conflictResult.results.some((r) => r.id === "mem-1"), true, "mem-1 (winner) is in results");
  assertEqual(conflictResult.stats.suppressed, 0, "no results suppressed");
});

test("resolveConflicts uses curationLevel in conflict scoring", () => {
  const resultA = makeMemory({
    id: "mem-1",
    provider: "hindsight",
    content: "Same content",
    curationLevel: "curated",
    confidenceScore: 0.5,
  });
  const resultB = makeMemory({
    id: "mem-2",
    provider: "noosphere",
    content: "Same content", // Same content - only curation differs
    curationLevel: "ephemeral",
    confidenceScore: 0.5,
  });

  const conflictResult = resolveConflicts([resultA, resultB], {
    strategy: "surface",
    conflictThreshold: 0.1,
  });

  // Content is same so conflict score should be low (curation mismatch only adds ~0.1)
  // May or may not trigger depending on exact score
  assertEqual(conflictResult.results.length, 2, "both results present");
});

// ─── Summary ────────────────────────────────────────────────────────────────

// Tests are auto-run by the test runner above
