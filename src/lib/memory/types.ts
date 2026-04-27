export type MemorySourceType =
  | "noosphere"
  | "hindsight"
  | "external"
  | "procedural"
  | (string & {});

export type MemoryCurationLevel = "ephemeral" | "managed" | "curated";

export type MemoryScore = number;

export type MemoryProviderMetadata = Record<string, unknown>;

export interface MemoryResult {
  /** Provider-local stable identifier for this memory result. */
  id: string;

  /** Provider identifier, for example "noosphere" or "hindsight". */
  provider: string;

  /** Broad provider/source category used by provider-agnostic policy code. */
  sourceType: MemorySourceType;

  /** Optional human-readable label. */
  title?: string;

  /** Normalized memory body. Providers should avoid putting metadata here. */
  content: string;

  /** Short form preferred for low-budget recall injection. */
  summary?: string;

  /** Query relevance, normalized to 0.0–1.0 when available. */
  relevanceScore?: MemoryScore;

  /** Provider confidence, normalized to 0.0–1.0 when available. */
  confidenceScore?: MemoryScore;

  /** Freshness signal, normalized to 0.0–1.0 when available. */
  recencyScore?: MemoryScore;

  /** How durable or reviewed the memory is. */
  curationLevel?: MemoryCurationLevel;

  /** ISO-8601 creation timestamp if the provider exposes one. */
  createdAt?: string;

  /** ISO-8601 update timestamp if the provider exposes one. */
  updatedAt?: string;

  /** Estimated prompt tokens for summary/content selection. */
  tokenEstimate?: number;

  /** Provider-agnostic canonical reference for dedupe, provenance, or linking. */
  canonicalRef?: string;

  /** Provider-agnostic tags or labels. */
  tags?: string[];

  /** Provider-specific fields must remain isolated here. */
  metadata?: MemoryProviderMetadata;
}

export type MemoryResultInput = MemoryResult;

export const DEFAULT_MEMORY_CHARS_PER_TOKEN = 4;

export function normalizeMemoryScore(score: number): MemoryScore {
  if (Number.isNaN(score)) {
    return 0;
  }

  return Math.max(0, Math.min(1, score));
}

export function estimateMemoryTokens(
  text: string,
  charsPerToken = DEFAULT_MEMORY_CHARS_PER_TOKEN,
): number {
  if (text.length === 0) {
    return 0;
  }

  const safeCharsPerToken =
    Number.isFinite(charsPerToken) && charsPerToken > 0
      ? charsPerToken
      : DEFAULT_MEMORY_CHARS_PER_TOKEN;

  return Math.ceil(text.length / safeCharsPerToken);
}

export function normalizeMemoryTokenEstimate(
  tokenEstimate: number | undefined,
): number | undefined {
  if (tokenEstimate === undefined || !Number.isFinite(tokenEstimate)) {
    return undefined;
  }

  return Math.max(0, Math.ceil(tokenEstimate));
}

export function defineMemoryResult(input: MemoryResultInput): MemoryResult {
  return {
    ...input,
    relevanceScore:
      input.relevanceScore === undefined
        ? undefined
        : normalizeMemoryScore(input.relevanceScore),
    confidenceScore:
      input.confidenceScore === undefined
        ? undefined
        : normalizeMemoryScore(input.confidenceScore),
    recencyScore:
      input.recencyScore === undefined
        ? undefined
        : normalizeMemoryScore(input.recencyScore),
    tokenEstimate:
      normalizeMemoryTokenEstimate(input.tokenEstimate) ??
      estimateMemoryTokens(input.summary || input.content),
  };
}

export function removeUndefined<T extends Record<string, unknown>>(
  value: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

// ─── Shared scoring constants ──────────────────────────────────────────────

/** Curation level → numeric score, used by orchestrator and conflict engine. */
export const CURATION_SCORE_MAP: Record<string, number> = {
  curated: 1.0,
  reviewed: 0.7,
  ephemeral: 0.3,
};

/** Weights for the composite memory score formula. */
export const COMPOSITE_WEIGHTS = {
  relevance: 0.4,
  confidence: 0.25,
  recency: 0.2,
  curation: 0.15,
} as const;

/**
 * Compute the base composite score for a memory result.
 * Shared by orchestrator (ranking) and conflict engine (adjusted scoring)
 * to ensure consistent weight calculations.
 */
export function computeBaseCompositeScore(
  result: MemoryResult,
): number {
  const relevance = result.relevanceScore ?? 0;
  const confidence = result.confidenceScore ?? 0;
  const recency = result.recencyScore ?? 0;
  const curation =
    CURATION_SCORE_MAP[result.curationLevel ?? ""] ?? 0.5;

  return normalizeMemoryScore(
    COMPOSITE_WEIGHTS.relevance * relevance +
    COMPOSITE_WEIGHTS.confidence * confidence +
    COMPOSITE_WEIGHTS.recency * recency +
    COMPOSITE_WEIGHTS.curation * curation,
  );
}
