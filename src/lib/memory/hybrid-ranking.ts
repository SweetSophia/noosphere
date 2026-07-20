export const HYBRID_RRF_K = 60;
export const HYBRID_CANDIDATE_DEPTH = 200;
export const HYBRID_MAX_WINDOW = 200;
export const HYBRID_VECTOR_AUTH_BATCH_SIZE = 1_000;

export interface RankedHybridSource {
  id: string;
  updatedAt: string;
}

export interface FusedHybridCandidate extends RankedHybridSource {
  rawRrfScore: number;
  lexicalRank?: number;
  vectorRank?: number;
}

export interface NormalizedHybridCandidate extends FusedHybridCandidate {
  relevanceScore: number;
}

/**
 * Fuse two already-authorized ranked lists with deterministic reciprocal rank
 * fusion. Duplicate source rows are ignored before rank assignment so a join
 * fan-out cannot alter either an article's rank or its contribution.
 */
export function fuseHybridCandidates(
  lexical: RankedHybridSource[],
  vector: RankedHybridSource[],
): FusedHybridCandidate[] {
  const lexicalRanks = rankUnique(lexical);
  const vectorRanks = rankUnique(vector);
  const candidates = new Map<string, FusedHybridCandidate>();

  for (const [id, source] of lexicalRanks) {
    candidates.set(id, {
      id,
      updatedAt: source.updatedAt,
      lexicalRank: source.rank,
      rawRrfScore: rrfContribution(source.rank),
    });
  }

  for (const [id, source] of vectorRanks) {
    const existing = candidates.get(id);
    if (existing) {
      existing.vectorRank = source.rank;
      existing.rawRrfScore += rrfContribution(source.rank);
      if (source.updatedAt > existing.updatedAt) {
        existing.updatedAt = source.updatedAt;
      }
    } else {
      candidates.set(id, {
        id,
        updatedAt: source.updatedAt,
        vectorRank: source.rank,
        rawRrfScore: rrfContribution(source.rank),
      });
    }
  }

  return [...candidates.values()].sort(compareFusedCandidates);
}

/** Normalize over the complete authorized fused set. Callers paginate later. */
export function normalizeHybridScores(
  candidates: FusedHybridCandidate[],
): NormalizedHybridCandidate[] {
  const maximum = candidates.reduce(
    (current, candidate) => Math.max(current, candidate.rawRrfScore),
    0,
  );

  return candidates.map((candidate) => ({
    ...candidate,
    relevanceScore: maximum === 0 ? 0 : candidate.rawRrfScore / maximum,
  }));
}

function rankUnique(
  sources: RankedHybridSource[],
): Map<string, RankedHybridSource & { rank: number }> {
  const ranked = new Map<string, RankedHybridSource & { rank: number }>();
  for (const source of sources) {
    if (!source.id || ranked.has(source.id)) continue;
    if (ranked.size >= HYBRID_CANDIDATE_DEPTH) break;
    ranked.set(source.id, { ...source, rank: ranked.size + 1 });
  }
  return ranked;
}

function rrfContribution(rank: number): number {
  return 1 / (HYBRID_RRF_K + rank);
}

function compareFusedCandidates(
  left: FusedHybridCandidate,
  right: FusedHybridCandidate,
): number {
  if (left.rawRrfScore !== right.rawRrfScore) {
    return right.rawRrfScore - left.rawRrfScore;
  }

  const leftBest = Math.min(
    left.lexicalRank ?? Number.POSITIVE_INFINITY,
    left.vectorRank ?? Number.POSITIVE_INFINITY,
  );
  const rightBest = Math.min(
    right.lexicalRank ?? Number.POSITIVE_INFINITY,
    right.vectorRank ?? Number.POSITIVE_INFINITY,
  );
  if (leftBest !== rightBest) return leftBest - rightBest;
  if (left.updatedAt !== right.updatedAt) {
    return right.updatedAt.localeCompare(left.updatedAt);
  }
  return left.id.localeCompare(right.id);
}
