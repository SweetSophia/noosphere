/**
 * Cross-provider deduplication for memory recall results.
 *
 * When multiple providers return the same or near-duplicate memory (identified
 * by `canonicalRef`), this module collapses them into a single entry while
 * preserving the full provider provenance — which providers found it and what
 * scores each provider assigned.
 *
 * @module dedup
 */

import type { MemoryResult } from "./types";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Strategy for collapsing duplicate results across providers. */
export type DeduplicationStrategy =
  /** Keep the result with the highest composite score. */
  | "best-score"
  /** Keep the result from the highest-priority provider. */
  | "provider-priority"
  /** Keep the most recently updated version. */
  | "most-recent";

export interface DeduplicationConfig {
  /** Strategy for choosing which duplicate to keep. Default: "best-score". */
  strategy?: DeduplicationStrategy;

  /**
   * Provider priority order (highest priority first).
   * Used when strategy is "provider-priority".
   */
  providerPriority?: string[];
}

/** Provenance entry for a single provider that returned a result. */
export interface ProviderProvenance {
  /** Provider ID that returned this result. */
  providerId: string;

  /** Provider-assigned relevance score (if any). */
  relevanceScore?: number;

  /** Provider-assigned confidence score (if any). */
  confidenceScore?: number;

  /** Provider-local result ID. */
  localId: string;
}

/** A memory result enriched with cross-provider provenance after dedup. */
export interface DeduplicatedResult {
  /** The winning memory result (determined by strategy). */
  result: MemoryResult;

  /** All providers that returned this same memory. */
  provenance: ProviderProvenance[];

  /** Number of duplicates that were collapsed. */
  collapsedCount: number;

  /** The provider ID of the winning result. */
  providerId: string;

  /** The composite score of the winning result. */
  compositeScore: number;
}

export interface DeduplicationStats {
  /** Total input results before deduplication. */
  totalInput: number;

  /** Results after deduplication. */
  totalOutput: number;

  /** Number of duplicate entries collapsed. */
  collapsedTotal: number;
}

export interface DeduplicationResult {
  /** Deduplicated results in original order. */
  results: DeduplicatedResult[];

  /** Aggregate deduplication statistics. */
  stats: DeduplicationStats;
}

// ─── Deduplicator ────────────────────────────────────────────────────────────

export class CrossProviderDeduplicator {
  private readonly strategy: DeduplicationStrategy;
  private readonly providerPriority: string[];

  constructor(config: DeduplicationConfig = {}) {
    this.strategy = config.strategy ?? "best-score";
    this.providerPriority = config.providerPriority ?? [];
  }

  /**
   * Deduplicate results that share the same `canonicalRef`.
   *
   * When no `canonicalRef` is set, the result is treated as unique and passes
   * through without deduplication.
   *
   * For each group of duplicates, the "winning" result is selected according
   * to the configured strategy. Provenance from all providers is preserved.
   */
  dedup(
    entries: ScoredCandidate[],
  ): DeduplicationResult {
    // Group by canonicalRef. Entries without canonicalRef use a deterministic
    // fallback key (providerId:localId) so same-provider duplicates are still
    // collapsed when they share the same local ID.
    const groups = new Map<string, ScoredCandidate[]>();

    for (const entry of entries) {
      const key = entry.result.canonicalRef ?? `${entry.providerId}:${entry.result.id}`;
      let group = groups.get(key);
      if (!group) {
        group = [];
        groups.set(key, group);
      }
      group.push(entry);
    }

    const results: DeduplicatedResult[] = [];
    let collapsedTotal = 0;

    for (const group of groups.values()) {
      const winner = this.selectWinner(group);
      const provenance = group.map((entry) => ({
        providerId: entry.providerId,
        relevanceScore: entry.result.relevanceScore,
        confidenceScore: entry.result.confidenceScore,
        localId: entry.result.id,
      }));

      const collapsedCount = group.length - 1;
      collapsedTotal += collapsedCount;

      results.push({
        result: winner.result,
        provenance,
        collapsedCount,
        providerId: winner.providerId,
        compositeScore: winner.compositeScore,
      });
    }

    return {
      results,
      stats: {
        totalInput: entries.length,
        totalOutput: results.length,
        collapsedTotal,
      },
    };
  }

  private selectWinner(
    candidates: ScoredCandidate[],
  ): ScoredCandidate {
    if (candidates.length === 1) return candidates[0];

    switch (this.strategy) {
      case "provider-priority":
        return this.selectByProviderPriority(candidates);
      case "most-recent":
        return this.selectByRecency(candidates);
      case "best-score":
      default:
        return this.selectByScore(candidates);
    }
  }

  private selectByScore(
    candidates: ScoredCandidate[],
  ): ScoredCandidate {
    // Highest compositeScore wins; tiebreak on relevanceScore.
    return candidates.reduce((best, current) => {
      const scoreDiff = current.compositeScore - best.compositeScore;
      if (Math.abs(scoreDiff) > 0.001) return scoreDiff > 0 ? current : best;
      const relBest = best.result.relevanceScore ?? 0;
      const relCurrent = current.result.relevanceScore ?? 0;
      return relCurrent > relBest ? current : best;
    });
  }

  private selectByProviderPriority(
    candidates: ScoredCandidate[],
  ): ScoredCandidate {
    if (this.providerPriority.length === 0) {
      // Fall back to best-score when no priority list is configured.
      return this.selectByScore(candidates);
    }

    return candidates.reduce((best, current) => {
      const bestIdx = this.providerPriority.indexOf(best.providerId);
      const curIdx = this.providerPriority.indexOf(current.providerId);
      // Lower index = higher priority. Missing providers get Infinity.
      const bestRank = bestIdx === -1 ? Infinity : bestIdx;
      const curRank = curIdx === -1 ? Infinity : curIdx;
      if (curRank !== bestRank) return curRank < bestRank ? current : best;
      // Tiebreak on score.
      return current.compositeScore > best.compositeScore ? current : best;
    });
  }

  private selectByRecency(
    candidates: ScoredCandidate[],
  ): ScoredCandidate {
    return candidates.reduce((best, current) => {
      const bestTime = best.result.updatedAt ?? best.result.createdAt ?? "";
      const curTime = current.result.updatedAt ?? current.result.createdAt ?? "";
      if (curTime > bestTime) return current;
      if (curTime === bestTime && current.compositeScore > best.compositeScore) {
        return current;
      }
      return best;
    });
  }
}

// ─── Candidate type (shared with orchestrator) ──────────────────────────────

export interface ScoredCandidate {
  result: MemoryResult;
  providerId: string;
  compositeScore: number;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createDeduplicator(
  config?: DeduplicationConfig,
): CrossProviderDeduplicator {
  return new CrossProviderDeduplicator(config);
}
