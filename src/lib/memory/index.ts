export type {
  HindsightMemoryType,
  HindsightProviderSettings,
  HindsightRecallBudget,
  HindsightRecallOptionsMetadata,
  HindsightRecallResponse,
  HindsightRecallResult,
  HindsightTagsMatch,
} from "./hindsight";

export type {
  NoosphereProviderSettings,
  NoosphereSearchOptionsMetadata,
} from "./noosphere";

export type {
  BudgetEntry,
  BudgetVerbosity,
  ContextBudgetConfig,
  BudgetResult,
} from "./budget";

export type {
  MemoryProvider,
  MemoryProviderCapabilities,
  MemoryProviderConfig,
  MemoryProviderDescriptor,
  MemoryProviderGetOptions,
  MemoryProviderScore,
  MemoryProviderScoreContext,
  MemoryProviderSearchOptions,
} from "./provider";

export type {
  MemoryCurationLevel,
  MemoryProviderMetadata,
  MemoryResult,
  MemoryResultInput,
  MemoryScore,
  MemorySourceType,
} from "./types";

export { createHindsightProvider, HindsightProvider } from "./hindsight";
export { createNoosphereProvider, NoosphereProvider } from "./noosphere";
export {
  RecallOrchestrator,
  createRecallOrchestrator,
} from "./orchestrator";
export type {
  RecallMode,
  RecallOrchestratorOptions,
  RecallOrchestratorProviderEntry,
  RecallQuery,
  RecallProviderMeta,
  RecallResponse,
  RecallResultRanked,
} from "./orchestrator";

export {
  ContextBudgetManager,
  createContextBudgetManager,
} from "./budget";

export {
  CrossProviderDeduplicator,
  createDeduplicator,
} from "./dedup";

export type {
  DeduplicationConfig,
  DeduplicationResult,
  DeduplicationStats,
  DeduplicationStrategy,
  ProviderProvenance,
  DeduplicatedResult,
} from "./dedup";

export {
  resolveConflicts,
  computeConflictScore,
  detectConflict,
  createConflictResolver,
} from "./conflict";

export type {
  ConflictAction,
  ConflictConfig,
  ConflictEntry,
  ConflictReason,
  ConflictResolutionResult,
  ConflictSignal,
  ConflictStats,
  ConflictStrategy,
} from "./conflict";

export {
  DEFAULT_RECALL_SETTINGS,
  mergeRecallSettings,
  normalizeRecallSettings,
} from "./settings";

export type { RecallSettings } from "./settings";

export {
  DEFAULT_MEMORY_PROVIDER_CAPABILITIES,
  DEFAULT_MEMORY_PROVIDER_CONFIG,
  getEffectiveAutoRecall,
  normalizeMemoryProviderConfig,
} from "./provider";

export {
  DEFAULT_MEMORY_CHARS_PER_TOKEN,
  defineMemoryResult,
  estimateMemoryTokens,
  normalizeMemoryTokenEstimate,
  normalizeMemoryScore,
  removeUndefined,
  CURATION_SCORE_MAP,
  COMPOSITE_WEIGHTS,
  computeBaseCompositeScore,
} from "./types";
