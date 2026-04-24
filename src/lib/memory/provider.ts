import type {
  MemoryProviderMetadata,
  MemoryResult,
  MemoryScore,
  MemorySourceType,
} from "./types";

export interface MemoryProviderConfig {
  /** Whether the provider is available for explicit recall queries. */
  enabled: boolean;

  /** Relative weighting used by orchestrators when combining providers. */
  priorityWeight: number;

  /** Optional provider-specific result cap before global budgeting. */
  maxResults?: number;

  /**
   * Optional policy flag controlling whether this provider may participate in
   * automatic recall injection.
   *
   * This can further restrict auto-recall participation but can never enable it
   * when the provider capability declares `autoRecall: false`.
   */
  allowAutoRecall?: boolean;

  /** Provider-specific config values must remain isolated here. */
  metadata?: MemoryProviderMetadata;
}

export interface MemoryProviderCapabilities {
  /** Provider supports free-text search over memory contents. */
  search: boolean;

  /** Provider supports direct lookup by provider-local memory ID. */
  getById: boolean;

  /** Provider emits or can compute score metadata for results. */
  score: boolean;

  /**
   * Provider can safely participate in low-budget automatic recall.
   *
   * This is a hard capability limit: if false, the provider must never be used
   * for auto-recall regardless of config flags.
   */
  autoRecall: boolean;
}

export interface MemoryProviderDescriptor {
  /** Stable provider identifier, for example "noosphere" or "hindsight". */
  id: string;

  /** Human-readable provider name for logs, diagnostics, or settings UI. */
  displayName?: string;

  /** Broad provider category used by provider-agnostic policy code. */
  sourceType: MemorySourceType;

  /** Default provider settings before user or environment overrides. */
  defaultConfig: MemoryProviderConfig;

  /** Contract features implemented by this provider. */
  capabilities: MemoryProviderCapabilities;

  /** Provider-specific descriptor fields must remain isolated here. */
  metadata?: MemoryProviderMetadata;
}

export interface MemoryProviderSearchOptions {
  /** Provider-local cap. Orchestrators may apply a stricter global cap later. */
  limit?: number;

  /** Optional topic/scope hint. Providers that cannot scope should ignore it. */
  scope?: string;

  /** Whether this query is for automatic prompt injection. */
  autoRecall?: boolean;

  /** Optional caller-provided provider config override. */
  config?: Partial<MemoryProviderConfig>;

  /** Abort signal for network-backed providers. */
  signal?: AbortSignal;

  /** Provider-specific query options must remain isolated here. */
  metadata?: MemoryProviderMetadata;
}

export interface MemoryProviderGetOptions {
  /** Optional caller-provided provider config override. */
  config?: Partial<MemoryProviderConfig>;

  /** Abort signal for network-backed providers. */
  signal?: AbortSignal;

  /** Provider-specific lookup options must remain isolated here. */
  metadata?: MemoryProviderMetadata;
}

export interface MemoryProviderScoreContext {
  /** Original query when score calculation is query-dependent. */
  query?: string;

  /** Current timestamp for deterministic freshness scoring in tests/jobs. */
  now?: Date;

  /** Provider config after global/user overrides. */
  config?: MemoryProviderConfig;
}

export interface MemoryProviderScore {
  /** Query relevance, normalized to 0.0–1.0 when available. */
  relevanceScore?: MemoryScore;

  /** Provider confidence, normalized to 0.0–1.0 when available. */
  confidenceScore?: MemoryScore;

  /** Freshness signal, normalized to 0.0–1.0 when available. */
  recencyScore?: MemoryScore;

  /** Provider-local combined utility score, normalized to 0.0–1.0 when available. */
  aggregateScore?: MemoryScore;

  /** Explainable scoring reasons for inspection/debug output. */
  reasons?: string[];

  /** Provider-specific score fields must remain isolated here. */
  metadata?: MemoryProviderMetadata;
}

export interface MemoryProvider {
  readonly descriptor: MemoryProviderDescriptor;

  /** Search provider memory and return normalized results. */
  search(
    query: string,
    options?: MemoryProviderSearchOptions,
  ): Promise<MemoryResult[]>;

  /** Return one normalized provider result by provider-local ID. */
  getById(
    id: string,
    options?: MemoryProviderGetOptions,
  ): Promise<MemoryResult | null>;

  /**
   * Optional synchronous provider-local scoring hook.
   *
   * Providers may use this to fill in or explain score metadata already present
   * on a MemoryResult. Orchestrators own final cross-provider ranking and must
   * not treat provider-local aggregate scores as globally comparable by default.
   */
  score?(
    result: MemoryResult,
    context?: MemoryProviderScoreContext,
  ): MemoryProviderScore;
}

export const DEFAULT_MEMORY_PROVIDER_CONFIG: MemoryProviderConfig = {
  enabled: true,
  priorityWeight: 1,
  allowAutoRecall: true,
};

export const DEFAULT_MEMORY_PROVIDER_CAPABILITIES: MemoryProviderCapabilities = {
  search: true,
  getById: true,
  score: false,
  autoRecall: true,
};

export function getEffectiveAutoRecall(
  capabilities: MemoryProviderCapabilities,
  config: Pick<MemoryProviderConfig, "allowAutoRecall">,
): boolean {
  return capabilities.autoRecall && config.allowAutoRecall !== false;
}

export function normalizeMemoryProviderConfig(
  config: Partial<MemoryProviderConfig> = {},
): MemoryProviderConfig {
  const priorityWeight =
    config.priorityWeight === undefined ||
    !Number.isFinite(config.priorityWeight) ||
    config.priorityWeight < 0
      ? DEFAULT_MEMORY_PROVIDER_CONFIG.priorityWeight
      : config.priorityWeight;

  const maxResults =
    config.maxResults === undefined ||
    !Number.isFinite(config.maxResults) ||
    config.maxResults <= 0
      ? undefined
      : Math.max(1, Math.floor(config.maxResults));

  const enabled =
    typeof config.enabled === "boolean"
      ? config.enabled
      : DEFAULT_MEMORY_PROVIDER_CONFIG.enabled;

  const allowAutoRecall =
    typeof config.allowAutoRecall === "boolean"
      ? config.allowAutoRecall
      : DEFAULT_MEMORY_PROVIDER_CONFIG.allowAutoRecall;

  return {
    ...DEFAULT_MEMORY_PROVIDER_CONFIG,
    ...config,
    enabled,
    allowAutoRecall,
    priorityWeight,
    maxResults,
  };
}
