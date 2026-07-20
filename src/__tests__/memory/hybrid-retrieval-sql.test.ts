import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHybridCacheHitSql,
  buildHybridMissSql,
} from "@/lib/memory/hybrid-retrieval-sql";
import {
  HYBRID_CANDIDATE_DEPTH,
  HYBRID_MAX_AUTHORIZED_CANDIDATES,
} from "@/lib/memory/hybrid-ranking";

function sqlText(query: { strings: readonly string[] }): string {
  return query.strings.join("?").replace(/\s+/g, " ");
}

const filters = {
  topicSlug: "engineering",
  tagSlug: "memory",
  status: "reviewed",
  confidence: "high",
  allowedScopes: ["team:a"],
};

test("miss query uses one shared authorized base for lexical and vector candidates", () => {
  const query = buildHybridMissSql({
    query: "remember café",
    profileId: "0198fe17-f4dd-7ee3-93e4-acde00000001",
    vectorLiteral: "[1,0,0]",
    limit: 10,
    offset: 0,
    filters,
  });
  const text = sqlText(query);

  assert.equal((text.match(/authorized_base AS MATERIALIZED/g) ?? []).length, 1);
  assert.match(text, /lexical_source AS MATERIALIZED .* FROM authorized_base/s);
  assert.match(text, /authorized_batches AS MATERIALIZED/);
  assert.match(text, /authorized_id_batches AS MATERIALIZED/);
  assert.match(text, /authorized_budget AS MATERIALIZED/);
  assert.match(text, /authorized_ids AS MATERIALIZED/);
  assert.match(
    text,
    /authorized_base AS MATERIALIZED .* FROM authorized_budget CROSS JOIN LATERAL/s,
  );
  assert.match(text, /authorized_budget\.authorized_count <= \?/);
  assert.equal(
    query.values.filter((value) => value === HYBRID_MAX_AUTHORIZED_CANDIDATES).length,
    3,
  );
  assert.equal(
    query.values.filter((value) => value === HYBRID_MAX_AUTHORIZED_CANDIDATES + 1).length,
    1,
  );
  assert.match(text, /AS authorization_budget_valid/);
  assert.match(text, /vector_batch_source AS MATERIALIZED .* JOIN authorized_base/s);
  assert.match(text, /vector_candidates/);
  assert.match(text, /pg_catalog\.array_agg\(id ORDER BY id\)/);
  assert.equal(
    query.values.filter((value) => value === HYBRID_CANDIDATE_DEPTH).length,
    2,
  );
  assert.match(text, /lexical_source AS MATERIALIZED .* LIMIT \?/s);
  assert.match(text, /vector_source AS MATERIALIZED .* LIMIT \?/s);
  assert.match(text, /60 \+ lexical_rank/);
  assert.match(text, /60 \+ vector_rank/);
});

test("miss query selects strict lexical matches before the bounded zero-result fallback", () => {
  const text = sqlText(buildHybridMissSql({
    query: "forgot photo reattach",
    profileId: "0198fe17-f4dd-7ee3-93e4-acde00000001",
    vectorLiteral: "[1,0,0]",
    limit: 10,
    offset: 0,
    filters,
  }));

  assert.match(text, /strict_match_exists AS MATERIALIZED/);
  assert.match(text, /effective_query AS MATERIALIZED/);
  assert.match(text, /NOT strict_match_exists\.matched/);
  assert.match(text, /to_tsquery\('simple'/);
});

test("miss query locks provenance before articles, normalizes before pagination, and emits a complete cache set", () => {
  const text = sqlText(buildHybridMissSql({
    query: "query",
    profileId: "0198fe17-f4dd-7ee3-93e4-acde00000001",
    vectorLiteral: "[1,0,0]",
    limit: 10,
    offset: 5,
    filters,
  }));

  const lineage = text.indexOf("lineage_locks AS MATERIALIZED");
  const article = text.indexOf("article_locks AS MATERIALIZED");
  assert.ok(lineage >= 0 && article > lineage);
  assert.match(text, /FOR SHARE OF lineage/);
  assert.match(text, /FOR SHARE OF article/);
  assert.ok(text.indexOf("normalized AS") < text.indexOf("paged AS"));
  assert.match(text, /cache_set AS MATERIALIZED .* FROM eligible_fused/s);
  assert.doesNotMatch(
    text.slice(text.indexOf("cache_set AS"), text.indexOf("SELECT TRUE AS cache_valid")),
    /FROM paged/,
  );
  assert.match(text, /jsonb_build_object\(\s*'id'/);
  assert.match(text, /pg_catalog\.sha256/);
  assert.match(text, /AS candidates_fingerprint/);
  assert.doesNotMatch(text, /pg_catalog\.least/);
  assert.match(text, /LEFT JOIN hydrated/);
});

test("cache-hit query rechecks epoch, lexical/vector contribution, authorization, and full membership", () => {
  const text = sqlText(buildHybridCacheHitSql({
    query: "query",
    profileId: "0198fe17-f4dd-7ee3-93e4-acde00000001",
    expectedEpoch: "42",
    candidates: [
      { id: "one", rawRrfScore: 0.03, lexicalRank: 1, vectorRank: 2 },
      { id: "two", rawRrfScore: 0.02, lexicalRank: 2 },
    ],
    limit: 10,
    offset: 0,
    filters,
  }));

  assert.match(text, /current_vector_membership/);
  assert.match(text, /candidate\."rawRrfScore" AS raw_rrf_score/);
  assert.match(text, /cache_epoch::text = .* FROM profile_epoch/);
  assert.match(text, /lexical_rank IS NULL OR/);
  assert.match(text, /vector_rank IS NULL OR/);
  assert.match(text, /eligible_count = cached_count/);
  assert.match(text, /cache_valid/);
  assert.match(text, /FOR SHARE OF lineage/);
  assert.match(text, /FOR SHARE OF article/);
});
