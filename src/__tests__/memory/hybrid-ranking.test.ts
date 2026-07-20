import assert from "node:assert/strict";
import test from "node:test";

import {
  HYBRID_CANDIDATE_DEPTH,
  HYBRID_MAX_WINDOW,
  HYBRID_RRF_K,
  fuseHybridCandidates,
  normalizeHybridScores,
} from "@/lib/memory/hybrid-ranking";

test("Phase C pins the accepted RRF constants", () => {
  assert.equal(HYBRID_RRF_K, 60);
  assert.equal(HYBRID_CANDIDATE_DEPTH, 200);
  assert.equal(HYBRID_MAX_WINDOW, 200);
});

test("RRF starts ranks at one, deduplicates IDs, and sums both contributions", () => {
  const fused = fuseHybridCandidates(
    [
      { id: "lexical-only", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "both", updatedAt: "2026-01-02T00:00:00.000Z" },
    ],
    [
      { id: "both", updatedAt: "2026-01-02T00:00:00.000Z" },
      { id: "vector-only", updatedAt: "2026-01-03T00:00:00.000Z" },
    ],
  );

  assert.deepEqual(
    fused.map(({ id, lexicalRank, vectorRank }) => ({ id, lexicalRank, vectorRank })),
    [
      { id: "both", lexicalRank: 2, vectorRank: 1 },
      { id: "lexical-only", lexicalRank: 1, vectorRank: undefined },
      { id: "vector-only", lexicalRank: undefined, vectorRank: 2 },
    ],
  );
  assert.equal(fused[0]?.rawRrfScore, 1 / 62 + 1 / 61);
});

test("RRF tie order is best rank, updatedAt descending, then ID ascending", () => {
  const fused = fuseHybridCandidates(
    [
      { id: "z", updatedAt: "2026-01-02T00:00:00.000Z" },
      { id: "a", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "b", updatedAt: "2026-01-01T00:00:00.000Z" },
    ],
    [
      { id: "a", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "z", updatedAt: "2026-01-02T00:00:00.000Z" },
      { id: "b", updatedAt: "2026-01-01T00:00:00.000Z" },
    ],
  );

  assert.deepEqual(fused.map(({ id }) => id), ["z", "a", "b"]);
});

test("duplicate source rows cannot distort rank or score", () => {
  const fused = fuseHybridCandidates(
    [
      { id: "one", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "one", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "two", updatedAt: "2026-01-01T00:00:00.000Z" },
    ],
    [],
  );

  assert.deepEqual(
    fused.map(({ id, lexicalRank }) => ({ id, lexicalRank })),
    [
      { id: "one", lexicalRank: 1 },
      { id: "two", lexicalRank: 2 },
    ],
  );
});

test("normalization happens over the complete authorized fused set before pagination", () => {
  const normalized = normalizeHybridScores([
    {
      id: "first",
      rawRrfScore: 0.04,
      lexicalRank: 1,
      vectorRank: 1,
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
    {
      id: "second",
      rawRrfScore: 0.02,
      lexicalRank: 2,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);

  assert.equal(normalized[0]?.relevanceScore, 1);
  assert.equal(normalized[1]?.relevanceScore, 0.5);
});
