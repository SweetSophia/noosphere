export type MemorySourceType =
  | "noosphere"
  | "hindsight"
  | "external"
  | "procedural"
  | (string & {});

export type MemoryCurationLevel = "ephemeral" | "reviewed" | "curated";

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
