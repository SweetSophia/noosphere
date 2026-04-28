/**
 * Conflict resolution engine for memory recall results.
 *
 * Detects semantic conflicts between results from different providers and
 * resolves them according to configurable strategies.
 *
 * ## Conflict vs Deduplication
 *
 * Deduplication collapses results that share the same canonicalRef (i.e., the
 * same memory from different providers). Conflict resolution handles cases where
 * DIFFERENT memories about the same topic/entity contradict each other.
 *
 * ## Strategies
 *
 * - accept-highest: Keep higher-scoring result, suppress the conflict signal
 * - accept-recent: Keep the more recent result
 * - accept-curated: Keep the more curated result
 * - surface: Keep all results and surface conflicts for caller inspection
 * - suppress-low: Suppress lower-scoring conflicting result silently
 *
 * @module conflict
 */

import {
  computeBaseCompositeScore,
  CURATION_SCORE_MAP,
  normalizeMemoryScore,
  type MemoryResult,
} from "./types";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ConflictStrategy =
  /** Keep the higher-scoring result, suppress conflict signal. */
  | "accept-highest"
  /** Keep the most recent result. */
  | "accept-recent"
  /** Keep the most curated result. */
  | "accept-curated"
  /** Keep all results and surface the conflict to the caller. */
  | "surface"
  /** Suppress the lower-scoring conflicting result silently. */
  | "suppress-low";

export interface ConflictConfig {
  /** Minimum score divergence (0.0–1.0) to trigger conflict detection. Default: 0.1 */
  conflictThreshold?: number;

  /** Conflict resolution strategy. Default: "surface" */
  strategy?: ConflictStrategy;

  /** Include conflict metadata in results. Default: true */
  includeConflictMetadata?: boolean;

  /** Provider priority weights for conflict resolution (providerId → weight). */
  providerPriorityWeights?: Record<string, number>;
}

export interface ConflictSignal {
  /** The first conflicting result. */
  resultA: MemoryResult;

  /** The second conflicting result. */
  resultB: MemoryResult;

  /** Composite divergence score (0.0–1.0). */
  conflictScore: number;

  /** Human-readable reason for the conflict. */
  reason: ConflictReason;
}

export type ConflictReason =
  /** Content differs significantly between results. */
  | "content-mismatch"
  /** Curation levels differ. */
  | "curation-mismatch"
  /** Facts contradict each other. */
  | "contradiction"
  /** Metadata (confidence, recency) diverges significantly. */
  | "metadata-divergence";

export interface ConflictEntry {
  /** The winning or surviving result after resolution. */
  winner: MemoryResult;

  /** The suppressed result (if any). */
  loser?: MemoryResult;

  /** The conflict signal (always present when there was a conflict). */
  conflict: ConflictSignal;

  /** The resolution action taken. */
  action: ConflictAction;
}

export type ConflictAction = "kept" | "suppressed" | "surfaced";

export interface ConflictStats {
  /** Total input results. */
  totalInput: number;

  /** Number of conflicting pairs detected. */
  conflictingPairs: number;

  /** Number of conflicts resolved (surfaced or suppressed). */
  resolved: number;

  /** Number of results suppressed. */
  suppressed: number;

  /** Number of conflicts surfaced (kept in output with signal). */
  surfaced: number;
}

export interface ConflictResolutionResult {
  /** Results after conflict resolution. */
  results: MemoryResult[];

  /** Conflict signals for surfaced conflicts. */
  conflicts: ConflictSignal[];

  /** Conflict resolution statistics. */
  stats: ConflictStats;
}

// ─── Conflict Detection ─────────────────────────────────────────────────────

/**
 * Compute a conflict score between two results.
 * Returns a value 0.0–1.0 indicating how much these results diverge.
 */
export function computeConflictScore(
  resultA: MemoryResult,
  resultB: MemoryResult,
): number {
  let divergence = 0;

  // Content divergence (most significant).
  if (resultA.content !== resultB.content) {
    divergence += 0.4;
  }

  // Curation level divergence.
  const curationA = CURATION_SCORE_MAP[resultA.curationLevel ?? "ephemeral"] ?? 0.3;
  const curationB = CURATION_SCORE_MAP[resultB.curationLevel ?? "ephemeral"] ?? 0.3;
  const curationDiff = Math.abs(curationA - curationB);
  if (curationDiff > 0.3) {
    divergence += 0.2;
  } else if (curationDiff > 0.1) {
    divergence += 0.1;
  }

  // Confidence divergence.
  const confA = resultA.confidenceScore ?? 0.5;
  const confB = resultB.confidenceScore ?? 0.5;
  const confDiff = Math.abs(confA - confB);
  if (confDiff > 0.4) {
    divergence += 0.2;
  } else if (confDiff > 0.2) {
    divergence += 0.1;
  }

  // Recency divergence (if timestamps are available).
  if (resultA.updatedAt && resultB.updatedAt) {
    const dateA = new Date(resultA.updatedAt).getTime();
    const dateB = new Date(resultB.updatedAt).getTime();
    const recencyDiffDays = Math.abs(dateA - dateB) / (24 * 60 * 60 * 1000);
    if (recencyDiffDays > 30) {
      divergence += 0.1;
    }
  }

  return normalizeMemoryScore(divergence);
}

/**
 * Detect the reason for a conflict between two results.
 */
function detectConflictReason(
  resultA: MemoryResult,
  resultB: MemoryResult,
): ConflictReason {
  // Content mismatch is the primary signal.
  if (resultA.content !== resultB.content) {
    // Check if timestamps or confidence suggest contradiction.
    const confA = resultA.confidenceScore ?? 0.5;
    const confB = resultB.confidenceScore ?? 0.5;
    const confDiff = Math.abs(confA - confB);

    if (confDiff > 0.3) {
      return "contradiction";
    }

    if (resultA.curationLevel !== resultB.curationLevel) {
      return "curation-mismatch";
    }

    return "content-mismatch";
  }

  // If content is the same, check metadata.
  if (resultA.curationLevel !== resultB.curationLevel) {
    return "curation-mismatch";
  }

  return "metadata-divergence";
}

/**
 * Detect a conflict between two results if the divergence exceeds the threshold.
 */
export function detectConflict(
  resultA: MemoryResult,
  resultB: MemoryResult,
  threshold: number,
): ConflictSignal | null {
  // Don't flag the same result as conflicting with itself.
  if (resultA.provider === resultB.provider && resultA.id === resultB.id) {
    return null;
  }

  const conflictScore = computeConflictScore(resultA, resultB);

  if (conflictScore < threshold) {
    return null;
  }

  return {
    resultA,
    resultB,
    conflictScore,
    reason: detectConflictReason(resultA, resultB),
  };
}

// ─── Scoring helpers ─────────────────────────────────────────────────────────

/**
 * Compute an adjusted score for a result considering provider weights.
 * Uses the shared base composite score for consistency with the orchestrator.
 */
export function computeAdjustedScore(
  result: MemoryResult,
  providerWeights: Record<string, number>,
): number {
  const base = computeBaseCompositeScore(result);
  const providerWeight = providerWeights[result.provider] ?? 1.0;
  return normalizeMemoryScore(base * providerWeight);
}

// ─── Conflict Resolution ─────────────────────────────────────────────────────

/**
 * Resolve conflicts among a list of results using the given configuration.
 *
 * ## Process
 * 1. Pair up all results and detect conflicts using the threshold.
 * 2. For each conflict, apply the resolution strategy.
 * 3. Return the resolved results along with any conflict signals.
 */
export function resolveConflicts(
  results: MemoryResult[],
  config: ConflictConfig = {},
): ConflictResolutionResult {
  const threshold = config.conflictThreshold ?? 0.1;
  const strategy = config.strategy ?? "surface";
  const providerWeights = config.providerPriorityWeights ?? {};
  const includeMetadata = config.includeConflictMetadata ?? true;

  const conflicts: ConflictSignal[] = [];
  const suppressed = new Set<string>();

  // Detect all conflicts.
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      const conflict = detectConflict(results[i], results[j], threshold);
      if (conflict) {
        conflicts.push(conflict);

        const resolved = resolveConflictPair(
          conflict,
          strategy,
          providerWeights,
        );

        if (resolved.action === "suppressed" && resolved.loser) {
          suppressed.add(`${resolved.loser.provider}:${resolved.loser.id}`);
        }
      }
    }
  }

  // Apply suppression and build final result list.
  const finalResults: MemoryResult[] = [];
  const surfacedResults = new Set<string>();

  for (const result of results) {
    if (suppressed.has(`${result.provider}:${result.id}`)) {
      // Skip suppressed results.
      continue;
    }

    // Check if this result was involved in a surfaced conflict.
    const hasSurfacedConflict = conflicts.some(
      (c) =>
        ((c.resultA.provider === result.provider && c.resultA.id === result.id) ||
         (c.resultB.provider === result.provider && c.resultB.id === result.id)) &&
        (strategy === "surface" ||
          (strategy === "accept-highest" && includeMetadata)),
    );

    if (hasSurfacedConflict && includeMetadata) {
      surfacedResults.add(`${result.provider}:${result.id}`);
    }

    finalResults.push(result);
  }

  return {
    results: finalResults,
    conflicts: strategy === "surface" ? conflicts : [],
    stats: {
      totalInput: results.length,
      conflictingPairs: conflicts.length,
      resolved: conflicts.length,
      suppressed: suppressed.size,
      surfaced: surfacedResults.size,
    },
  };
}

/**
 * Resolve a single conflict pair using the specified strategy.
 */
function resolveConflictPair(
  conflict: ConflictSignal,
  strategy: ConflictStrategy,
  providerWeights: Record<string, number>,
): ConflictEntry {
  const { resultA, resultB } = conflict;

  const scoreA = computeAdjustedScore(resultA, providerWeights);
  const scoreB = computeAdjustedScore(resultB, providerWeights);

  switch (strategy) {
    case "accept-highest": {
      const winner = scoreA >= scoreB ? resultA : resultB;
      const loser = winner === resultA ? resultB : resultA;
      // accept-highest picks the winner but keeps the loser (doesn't filter it out)
      return { winner, loser, conflict, action: "kept" };
    }

    case "accept-recent": {
      const dateA = resultA.updatedAt ?? resultA.createdAt ?? "";
      const dateB = resultB.updatedAt ?? resultB.createdAt ?? "";
      // Parse as Date for correct numeric comparison (handles timezone offsets correctly).
      // Fall back to 0 for missing/invalid dates so the other result wins.
      const timeA = dateA ? new Date(dateA).getTime() : 0;
      const timeB = dateB ? new Date(dateB).getTime() : 0;
      const winner = timeA >= timeB ? resultA : resultB;
      const loser = winner === resultA ? resultB : resultA;
      return { winner, loser, conflict, action: "kept" };
    }

    case "accept-curated": {
      const curationRank: Record<string, number> = { curated: 3, managed: 2, ephemeral: 1 };
      const rankA = curationRank[resultA.curationLevel ?? "ephemeral"] ?? 1;
      const rankB = curationRank[resultB.curationLevel ?? "ephemeral"] ?? 1;
      const winner = rankA >= rankB ? resultA : resultB;
      const loser = winner === resultA ? resultB : resultA;
      return { winner, loser, conflict, action: "kept" };
    }

    case "surface": {
      // Keep both, surface the conflict.
      return {
        winner: resultA,
        loser: resultB,
        conflict,
        action: "surfaced",
      };
    }

    case "suppress-low": {
      const winner = scoreA >= scoreB ? resultA : resultB;
      const loser = winner === resultA ? resultB : resultA;
      return { winner, loser, conflict, action: "suppressed" };
    }

    default: {
      // Unknown strategy: surface by default.
      return { winner: resultA, loser: resultB, conflict, action: "surfaced" };
    }
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a conflict resolver function with the given config.
 * Useful for passing a configured resolver to the orchestrator.
 */
export function createConflictResolver(
  config: ConflictConfig = {},
): (results: MemoryResult[]) => ConflictResolutionResult {
  return (results) => resolveConflicts(results, config);
}
