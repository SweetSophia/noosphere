/**
 * Promotion pipeline for memory curation.
 *
 * Identifies ephemeral or managed memories that have been recalled reliably
 * enough to warrant promotion to a higher curation level, and manages the
 * review flow for approving or rejecting those promotions.
 *
 * ## Promotion Path
 *
 *   ephemeral → managed → curated
 *
 * A memory is a promotion candidate when:
 * - It has been recalled at least `minRecallCount` times
 * - Its average relevance across recalls is above `minAvgRelevance`
 * - It is not already at the highest curation level ("curated")
 *
 * ## Review Flow
 *
 * 1. Candidate detected → status "pending"
 * 2. Operator reviews → status "approved" or "rejected"
 * 3. Approved candidates are picked up by the backfill/synthesis pipeline
 *
 * @module promotion
 */

import type { MemoryCurationLevel, MemoryResult } from "./types";

// ─── Types ──────────────────────────────────────────────────────────────────

export type PromotionStatus = "pending" | "approved" | "rejected";

export type PromotionTargetLevel = Exclude<MemoryCurationLevel, "ephemeral">;

/** Tracks recall statistics for a memory over time. */
export interface MemoryRecallStats {
  /** Provider-local memory ID. */
  memoryId: string;

  /** Provider that owns the memory. */
  provider: string;

  /** Number of times this memory has been recalled. */
  recallCount: number;

  /** Sum of relevance scores across all recalls. */
  relevanceSum: number;

  /** Current curation level of the memory. */
  curationLevel: MemoryCurationLevel;

  /** ISO-8601 timestamp of the first recall. */
  firstRecalledAt?: string;

  /** ISO-8601 timestamp of the most recent recall. */
  lastRecalledAt?: string;
}

/** A promotion candidate with its computed eligibility. */
export interface PromotionCandidate {
  /** Provider-local memory ID. */
  memoryId: string;

  /** Provider that owns the memory. */
  provider: string;

  /** Current curation level. */
  currentLevel: MemoryCurationLevel;

  /** Target curation level after promotion. */
  targetLevel: MemoryCurationLevel;

  /** Number of times recalled. */
  recallCount: number;

  /** Average relevance across recalls (0.0–1.0). */
  avgRelevance: number;

  /** Review status. */
  status: PromotionStatus;

  /** ISO-8601 timestamp when the candidate was created. */
  createdAt: string;

  /** ISO-8601 timestamp of the most recent status change. */
  updatedAt: string;

  /** Optional reviewer notes. */
  notes?: string;

  /** Optional reference to the original memory content hash for dedup. */
  contentHash?: string;
}

export interface PromotionConfig {
  /** Minimum recall count before a memory becomes a promotion candidate. */
  minRecallCount: number;

  /** Minimum average relevance (0.0–1.0) to qualify for promotion. */
  minAvgRelevance: number;

  /**
   * Curation level mapping for promotion targets.
   * Default: ephemeral → managed, managed → curated.
   */
  promotionTargets: Record<MemoryCurationLevel, MemoryCurationLevel | null>;

  /**
   * Maximum number of pending candidates to keep.
   * Oldest candidates are pruned when the limit is exceeded.
   */
  maxPendingCandidates: number;
}

export interface PromotionReview {
  /** The candidate being reviewed. */
  candidateId: string;

  /** New status after review. */
  status: "approved" | "rejected";

  /** Optional reviewer notes. */
  notes?: string;

  /** ISO-8601 timestamp of the review. */
  reviewedAt: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

export const DEFAULT_PROMOTION_CONFIG: PromotionConfig = {
  minRecallCount: 3,
  minAvgRelevance: 0.5,
  promotionTargets: {
    ephemeral: "managed",
    managed: "curated",
    curated: null,
  },
  maxPendingCandidates: 100,
};

/** Next curation level in the promotion ladder. */
const CURATION_LADDER: Record<MemoryCurationLevel, MemoryCurationLevel | null> =
  {
    ephemeral: "managed",
    managed: "curated",
    curated: null,
  };

// ─── Functions ──────────────────────────────────────────────────────────────

/**
 * Compute a stable candidate key for deduplication of promotion candidates.
 * Uses provider + memoryId to uniquely identify a candidate.
 */
export function computeCandidateKey(
  provider: string,
  memoryId: string,
): string {
  return `${provider}:${memoryId}`;
}

/**
 * Determine the next curation level for a memory.
 * Returns null if already at the highest level ("curated").
 */
export function getNextCurationLevel(
  current: MemoryCurationLevel,
): MemoryCurationLevel | null {
  return CURATION_LADDER[current] ?? null;
}

/**
 * Check if a memory is eligible for promotion based on its recall stats.
 */
export function isEligibleForPromotion(
  stats: MemoryRecallStats,
  config: PromotionConfig = DEFAULT_PROMOTION_CONFIG,
): boolean {
  // Already curated — no higher level
  if (stats.curationLevel === "curated") {
    return false;
  }

  // Must meet minimum recall count
  if (stats.recallCount < config.minRecallCount) {
    return false;
  }

  // Must meet minimum average relevance
  const avgRelevance =
    stats.recallCount > 0 ? stats.relevanceSum / stats.recallCount : 0;

  if (avgRelevance < config.minAvgRelevance) {
    return false;
  }

  return true;
}

/**
 * Create a promotion candidate from recall stats.
 * Returns null if the memory is not eligible.
 */
export function createPromotionCandidate(
  stats: MemoryRecallStats,
  now: string = new Date().toISOString(),
  config: PromotionConfig = DEFAULT_PROMOTION_CONFIG,
): PromotionCandidate | null {
  if (!isEligibleForPromotion(stats, config)) {
    return null;
  }

  const targetLevel = config.promotionTargets[stats.curationLevel] ?? null;
  if (!targetLevel) {
    return null;
  }

  const avgRelevance =
    stats.recallCount > 0 ? stats.relevanceSum / stats.recallCount : 0;

  return {
    memoryId: stats.memoryId,
    provider: stats.provider,
    currentLevel: stats.curationLevel,
    targetLevel,
    recallCount: stats.recallCount,
    avgRelevance: Math.round(avgRelevance * 1000) / 1000, // 3 decimal places
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Apply a review decision to a promotion candidate.
 * Returns the updated candidate.
 */
export function applyReview(
  candidate: PromotionCandidate,
  review: PromotionReview,
): PromotionCandidate {
  return {
    ...candidate,
    status: review.status,
    notes: review.notes ?? candidate.notes,
    updatedAt: review.reviewedAt,
  };
}

/**
 * Scan a set of recall stats and produce promotion candidates.
 * Filters out ineligible memories and deduplicates by provider:memoryId.
 */
export function scanForCandidates(
  statsList: MemoryRecallStats[],
  existingCandidateKeys: Set<string> = new Set(),
  config: PromotionConfig = DEFAULT_PROMOTION_CONFIG,
  now: string = new Date().toISOString(),
): PromotionCandidate[] {
  const candidates: PromotionCandidate[] = [];
  const seenCandidateKeys = new Set(existingCandidateKeys);

  for (const stats of statsList) {
    const key = computeCandidateKey(stats.provider, stats.memoryId);

    // Skip if already a candidate or already seen in this scan
    if (seenCandidateKeys.has(key)) {
      continue;
    }

    const candidate = createPromotionCandidate(stats, now, config);
    if (candidate) {
      candidates.push(candidate);
      seenCandidateKeys.add(key);
    }
  }

  return candidates;
}

/**
 * Update recall statistics when a memory is recalled.
 * Creates new stats if none exist for this memory.
 */
export function recordRecall(
  existing: Map<string, MemoryRecallStats>,
  result: MemoryResult,
  now: string = new Date().toISOString(),
): MemoryRecallStats {
  const key = computeCandidateKey(result.provider, result.id);
  const current = existing.get(key);

  if (!current) {
    const stats: MemoryRecallStats = {
      memoryId: result.id,
      provider: result.provider,
      recallCount: 1,
      relevanceSum: result.relevanceScore ?? 0,
      curationLevel: result.curationLevel ?? "ephemeral",
      firstRecalledAt: now,
      lastRecalledAt: now,
    };
    existing.set(key, stats);
    return stats;
  }

  current.recallCount += 1;
  current.relevanceSum += result.relevanceScore ?? 0;
  current.curationLevel = result.curationLevel ?? current.curationLevel;
  current.lastRecalledAt = now;

  return current;
}

/**
 * Prune pending candidates to stay within the configured limit.
 * Removes oldest candidates first.
 */
export function prunePendingCandidates(
  candidates: PromotionCandidate[],
  maxPending: number = DEFAULT_PROMOTION_CONFIG.maxPendingCandidates,
): PromotionCandidate[] {
  const pending = candidates.filter((c) => c.status === "pending");
  const nonPending = candidates.filter((c) => c.status !== "pending");

  if (pending.length <= maxPending) {
    return candidates;
  }

  // Sort pending by createdAt ascending (oldest first)
  const sorted = pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // Keep only the newest maxPending candidates
  const kept = sorted.slice(sorted.length - maxPending);
  return [...nonPending, ...kept];
}
