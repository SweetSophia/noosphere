import assert from "node:assert/strict";
import test from "node:test";

import {
  HybridCorrectnessError,
  HybridLexicalFallbackError,
} from "@/lib/memory/hybrid-retrieval";
import { parseHybridQueryRows } from "@/lib/memory/hybrid-retrieval-runtime";

type RawRow = Parameters<typeof parseHybridQueryRows>[0][number];

function sentinelRow(
  candidates: unknown,
  candidatesFingerprint: string,
): RawRow {
  return {
    cache_valid: true,
    authorization_budget_valid: true,
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

test("row parsing classifies an exceeded authorization budget as lexical fallback", () => {
  const row = sentinelRow([], "a".repeat(64));
  row.authorization_budget_valid = false;

  assert.throws(
    () => parseHybridQueryRows([row]),
    (error) =>
      error instanceof HybridLexicalFallbackError &&
      error.code === "authorized_candidate_limit_exceeded",
  );
});

test("row parsing rejects inconsistent authorization-budget metadata", () => {
  for (const budgetValues of [[false, true], [true, false]]) {
    const rows = budgetValues.map((authorizationBudgetValid) => {
      const row = sentinelRow([], "a".repeat(64));
      row.authorization_budget_valid = authorizationBudgetValid;
      return row;
    });

    assert.throws(
      () => parseHybridQueryRows(rows),
      (error) =>
        error instanceof HybridCorrectnessError &&
        error.code === "hybrid_query_metadata_inconsistent",
    );
  }
});

test("over-budget fallback still rejects inconsistent query metadata", () => {
  const mutations: Array<(row: RawRow) => void> = [
    (row) => { row.cache_valid = false; },
    (row) => { row.epoch = "43"; },
    (row) => { row.candidates_fingerprint = "b".repeat(64); },
  ];

  for (const mutate of mutations) {
    const rows = [
      sentinelRow([], "a".repeat(64)),
      sentinelRow([], "a".repeat(64)),
    ];
    for (const row of rows) row.authorization_budget_valid = false;
    mutate(rows[1]);

    assert.throws(
      () => parseHybridQueryRows(rows),
      (error) =>
        error instanceof HybridCorrectnessError &&
        error.code === "hybrid_query_metadata_inconsistent",
    );
  }
});

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
