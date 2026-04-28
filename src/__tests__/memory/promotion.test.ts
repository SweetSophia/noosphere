/**
 * Tests for the promotion pipeline.
 *
 * Covers: eligibility detection, candidate creation, review flow,
 * recall recording, candidate scanning, and pruning.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PROMOTION_CONFIG,
  computeCandidateKey,
  getNextCurationLevel,
  isEligibleForPromotion,
  createPromotionCandidate,
  applyReview,
  scanForCandidates,
  recordRecall,
  prunePendingCandidates,
  type MemoryRecallStats,
  type PromotionConfig,
} from "@/lib/memory/promotion";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeStats(
  overrides: Partial<MemoryRecallStats> = {},
): MemoryRecallStats {
  return {
    memoryId: "mem-1",
    provider: "test",
    recallCount: 5,
    relevanceSum: 3.5,
    curationLevel: "ephemeral",
    firstRecalledAt: "2026-01-01T00:00:00Z",
    lastRecalledAt: "2026-04-27T00:00:00Z",
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("promotion", () => {
  // [1] getNextCurationLevel returns correct ladder
  test("[1] curation ladder: ephemeral → managed", () => {
    assert.equal(getNextCurationLevel("ephemeral"), "managed");
  });

  test("[2] curation ladder: managed → curated", () => {
    assert.equal(getNextCurationLevel("managed"), "curated");
  });

  test("[3] curation ladder: curated → null", () => {
    assert.equal(getNextCurationLevel("curated"), null);
  });

  // [4] computeCandidateKey
  test("[4] candidate key combines provider and memoryId", () => {
    assert.equal(
      computeCandidateKey("hindsight", "mem-42"),
      "hindsight:mem-42",
    );
  });

  // [5] isEligibleForPromotion: eligible ephemeral
  test("[5] eligible: ephemeral with 5 recalls and 0.7 avg relevance", () => {
    const stats = makeStats({ recallCount: 5, relevanceSum: 3.5 });
    assert.equal(isEligibleForPromotion(stats), true);
  });

  // [6] not eligible: curated
  test("[6] not eligible: curated memory", () => {
    const stats = makeStats({ curationLevel: "curated" });
    assert.equal(isEligibleForPromotion(stats), false);
  });

  // [7] not eligible: too few recalls
  test("[7] not eligible: recall count below threshold", () => {
    const stats = makeStats({ recallCount: 1 });
    assert.equal(isEligibleForPromotion(stats), false);
  });

  // [8] not eligible: low relevance
  test("[8] not eligible: avg relevance below threshold", () => {
    const stats = makeStats({ recallCount: 5, relevanceSum: 0.5 }); // avg 0.1
    assert.equal(isEligibleForPromotion(stats), false);
  });

  // [9] eligible: exactly at thresholds
  test("[9] eligible: exactly at minRecallCount and minAvgRelevance", () => {
    const config: PromotionConfig = {
      ...DEFAULT_PROMOTION_CONFIG,
      minRecallCount: 3,
      minAvgRelevance: 0.5,
    };
    const stats = makeStats({ recallCount: 3, relevanceSum: 1.5 }); // avg 0.5
    assert.equal(isEligibleForPromotion(stats, config), true);
  });

  // [10] createPromotionCandidate: success
  test("[10] creates candidate from eligible stats", () => {
    const stats = makeStats();
    const candidate = createPromotionCandidate(stats, "2026-04-27T00:00:00Z");
    assert.ok(candidate);
    assert.equal(candidate!.memoryId, "mem-1");
    assert.equal(candidate!.provider, "test");
    assert.equal(candidate!.currentLevel, "ephemeral");
    assert.equal(candidate!.targetLevel, "managed");
    assert.equal(candidate!.recallCount, 5);
    assert.equal(candidate!.avgRelevance, 0.7);
    assert.equal(candidate!.status, "pending");
  });

  // [11] createPromotionCandidate: returns null for ineligible
  test("[11] returns null for curated memory", () => {
    const stats = makeStats({ curationLevel: "curated" });
    assert.equal(createPromotionCandidate(stats), null);
  });

  // [12] createPromotionCandidate: managed → curated
  test("[12] managed memory promotes to curated", () => {
    const stats = makeStats({ curationLevel: "managed" });
    const candidate = createPromotionCandidate(stats);
    assert.ok(candidate);
    assert.equal(candidate!.targetLevel, "curated");
  });

  // [13] applyReview: approve
  test("[13] approve candidate", () => {
    const stats = makeStats();
    const candidate = createPromotionCandidate(stats)!;
    const reviewed = applyReview(candidate, {
      candidateId: candidate.memoryId,
      status: "approved",
      notes: "Looks good",
      reviewedAt: "2026-04-27T12:00:00Z",
    });
    assert.equal(reviewed.status, "approved");
    assert.equal(reviewed.notes, "Looks good");
    assert.equal(reviewed.updatedAt, "2026-04-27T12:00:00Z");
  });

  // [14] applyReview: reject
  test("[14] reject candidate", () => {
    const stats = makeStats();
    const candidate = createPromotionCandidate(stats)!;
    const reviewed = applyReview(candidate, {
      candidateId: candidate.memoryId,
      status: "rejected",
      reviewedAt: "2026-04-27T12:00:00Z",
    });
    assert.equal(reviewed.status, "rejected");
  });

  // [15] scanForCandidates: filters eligible
  test("[15] scan finds eligible candidates", () => {
    const eligible = makeStats({ recallCount: 5, relevanceSum: 3.5 });
    const ineligible = makeStats({ memoryId: "mem-2", recallCount: 1 });
    const candidates = scanForCandidates([eligible, ineligible]);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].memoryId, "mem-1");
  });

  // [16] scanForCandidates: deduplicates existing
  test("[16] scan skips existing candidate keys", () => {
    const stats = makeStats();
    const existing = new Set([computeCandidateKey("test", "mem-1")]);
    const candidates = scanForCandidates([stats], existing);
    assert.equal(candidates.length, 0);
  });

  // [16b] scanForCandidates: deduplicates duplicate stats within same scan
  test("[16b] scan skips duplicate stats entries in same run", () => {
    const stats = makeStats();
    const duplicate = makeStats();
    const candidates = scanForCandidates([stats, duplicate]);
    assert.equal(candidates.length, 1);
  });

  // [17] recordRecall: new memory
  test("[17] recordRecall creates new stats", () => {
    const map = new Map<string, MemoryRecallStats>();
    const stats = recordRecall(
      map,
      {
        id: "mem-new",
        provider: "hindsight",
        content: "test",
        relevanceScore: 0.8,
        curationLevel: "ephemeral",
      } as any,
      "2026-04-27T00:00:00Z",
    );

    assert.equal(stats.recallCount, 1);
    assert.equal(stats.relevanceSum, 0.8);
    assert.equal(stats.memoryId, "mem-new");
    assert.equal(map.size, 1);
  });

  // [18] recordRecall: update existing
  test("[18] recordRecall updates existing stats", () => {
    const map = new Map<string, MemoryRecallStats>();
    const result = {
      id: "mem-1",
      provider: "test",
      content: "test",
      relevanceScore: 0.9,
      curationLevel: "ephemeral",
    } as any;

    recordRecall(map, result, "2026-04-27T00:00:00Z");
    const stats = recordRecall(map, result, "2026-04-27T01:00:00Z");

    assert.equal(stats.recallCount, 2);
    assert.equal(stats.relevanceSum, 1.8);
    assert.equal(stats.lastRecalledAt, "2026-04-27T01:00:00Z");
  });

  // [19] prunePendingCandidates: under limit
  test("[19] prune keeps all when under limit", () => {
    const candidates = Array.from(
      { length: 5 },
      (_, i) =>
        createPromotionCandidate(
          makeStats({ memoryId: `mem-${i}` }),
          new Date(Date.now() + i * 1000).toISOString(),
        )!,
    );
    const pruned = prunePendingCandidates(candidates, 10);
    assert.equal(pruned.length, 5);
  });

  // [20] prunePendingCandidates: over limit
  test("[20] prune removes oldest when over limit", () => {
    const candidates = Array.from(
      { length: 10 },
      (_, i) =>
        createPromotionCandidate(
          makeStats({ memoryId: `mem-${i}` }),
          new Date(Date.now() + i * 1000).toISOString(),
        )!,
    );
    const pruned = prunePendingCandidates(candidates, 5);
    const pending = pruned.filter((c) => c.status === "pending");
    assert.equal(pending.length, 5);
    // Should keep the newest (highest index)
    assert.equal(pending[pending.length - 1].memoryId, "mem-9");
  });

  // [21] prunePendingCandidates: preserves non-pending
  test("[21] prune preserves approved/rejected candidates", () => {
    const candidates = Array.from(
      { length: 8 },
      (_, i) =>
        createPromotionCandidate(
          makeStats({ memoryId: `mem-${i}` }),
          new Date(Date.now() + i * 1000).toISOString(),
        )!,
    );
    // Approve the first one
    candidates[0] = applyReview(candidates[0], {
      candidateId: candidates[0].memoryId,
      status: "approved",
      reviewedAt: "2026-04-27T12:00:00Z",
    });

    const pruned = prunePendingCandidates(candidates, 5);
    const approved = pruned.filter((c) => c.status === "approved");
    assert.equal(approved.length, 1);
  });

  // [22] avg relevance rounding
  test("[22] avgRelevance is rounded to 3 decimal places", () => {
    const stats = makeStats({ recallCount: 3, relevanceSum: 2.3333 });
    const candidate = createPromotionCandidate(stats)!;
    assert.equal(candidate.avgRelevance, 0.778); // 2.3333/3 = 0.777767 → 0.778
  });
});

describe("promotion config", () => {
  // [23] custom config thresholds
  test("[23] custom config with higher thresholds", () => {
    const config: PromotionConfig = {
      ...DEFAULT_PROMOTION_CONFIG,
      minRecallCount: 10,
      minAvgRelevance: 0.8,
    };
    const stats = makeStats({ recallCount: 8, relevanceSum: 6.0 });
    assert.equal(isEligibleForPromotion(stats, config), false); // recallCount 8 < 10
  });

  // [24] custom config with lower thresholds
  test("[24] custom config with lower thresholds", () => {
    const config: PromotionConfig = {
      ...DEFAULT_PROMOTION_CONFIG,
      minRecallCount: 1,
      minAvgRelevance: 0.1,
    };
    const stats = makeStats({ recallCount: 1, relevanceSum: 0.2 });
    assert.equal(isEligibleForPromotion(stats, config), true);
  });

  // [24b] createPromotionCandidate uses config promotionTargets mapping
  test("[24b] createPromotionCandidate respects custom promotionTargets", () => {
    const config: PromotionConfig = {
      ...DEFAULT_PROMOTION_CONFIG,
      promotionTargets: {
        ephemeral: "curated",
        managed: "curated",
        curated: null,
      },
    };
    const candidate = createPromotionCandidate(makeStats(), undefined, config)!;
    assert.equal(candidate.targetLevel, "curated");
  });

  // [25] recordRecall preserves curationLevel from latest recall
  test("[25] recordRecall updates curationLevel from result", () => {
    const map = new Map<string, MemoryRecallStats>();
    const result1 = {
      id: "mem-1",
      provider: "test",
      content: "test",
      relevanceScore: 0.5,
      curationLevel: "ephemeral",
    } as any;
    const result2 = {
      id: "mem-1",
      provider: "test",
      content: "test",
      relevanceScore: 0.7,
      curationLevel: "managed",
    } as any;

    recordRecall(map, result1);
    const stats = recordRecall(map, result2);
    assert.equal(stats.curationLevel, "managed");
  });

  // [26] createPromotionCandidate uses config.promotionTargets
  test("[26] createPromotionCandidate respects custom promotionTargets", () => {
    const config: PromotionConfig = {
      ...DEFAULT_PROMOTION_CONFIG,
      promotionTargets: {
        ephemeral: "curated", // skip managed, go straight to curated
        managed: "curated",
        curated: null,
      },
    };
    const stats = makeStats({ curationLevel: "ephemeral" });
    const candidate = createPromotionCandidate(
      stats,
      "2026-04-27T00:00:00Z",
      config,
    );
    assert.ok(candidate);
    assert.equal(candidate!.targetLevel, "curated");
  });
});
