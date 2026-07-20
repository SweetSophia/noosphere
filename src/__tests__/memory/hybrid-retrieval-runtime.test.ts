import assert from "node:assert/strict";
import test from "node:test";

import { HybridCorrectnessError } from "@/lib/memory/hybrid-retrieval";
import { parseHybridQueryRows } from "@/lib/memory/hybrid-retrieval-runtime";

type RawRow = Parameters<typeof parseHybridQueryRows>[0][number];

function sentinelRow(
  candidates: unknown,
  candidatesFingerprint: string,
): RawRow {
  return {
    cache_valid: true,
    epoch: "42",
    candidates,
    candidates_fingerprint: candidatesFingerprint,
    fused_set_size: Array.isArray(candidates) ? candidates.length : 0,
    id: null,
    raw_rrf_score: null,
    lexical_rank: null,
    vector_rank: null,
    relevance_score: null,
    title: null,
    slug: null,
    content: null,
    excerpt: null,
    status: null,
    confidence: null,
    sourceUrl: null,
    sourceType: null,
    createdAt: null,
    updatedAt: null,
    lastReviewed: null,
    authorId: null,
    authorName: null,
    topic_id: null,
    topic_slug: null,
    topic_name: null,
    tags: null,
  };
}

test("row parsing rejects inconsistent candidate-set fingerprints", () => {
  const candidateA = [{ id: "a", rawRrfScore: 1 / 61, lexicalRank: 1 }];
  const candidateB = [{ id: "b", rawRrfScore: 1 / 61, lexicalRank: 1 }];
  const rows = [
    sentinelRow(candidateA, "a".repeat(64)),
    sentinelRow(candidateB, "b".repeat(64)),
  ];

  assert.throws(
    () => parseHybridQueryRows(rows),
    (error) =>
      error instanceof HybridCorrectnessError &&
      error.code === "hybrid_query_metadata_inconsistent",
  );
});
