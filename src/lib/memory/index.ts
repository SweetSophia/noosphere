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
  toConflictConfig,
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

export {
  DEFAULT_PROMOTION_CONFIG,
  computeCandidateKey,
  getNextCurationLevel,
  isEligibleForPromotion,
  createPromotionCandidate,
  applyReview,
  scanForCandidates,
  recordRecall,
  prunePendingCandidates,
} from "./promotion";

export type {
  MemoryRecallStats,
  PromotionCandidate,
  PromotionConfig,
  PromotionReview,
  PromotionStatus,
} from "./promotion";

export {
  DEFAULT_SYNTHESIS_CONFIG,
  slugify,
  generateJobId,
  createSynthesisJob,
  mergeContent,
  prepareSynthesisInput,
  synthesize,
  updateJobStatus,
  canRetry,
  retryJob,
  getPendingJobs,
  filterJobsByStatus,
} from "./backfill";

export type {
  SynthesisConfig,
  SynthesisInput,
  SynthesisJob,
  SynthesisResult,
  SynthesisStatus,
  ContentStrategy,
} from "./backfill";

export {
  LocalMemoryScheduler,
  createLocalMemoryScheduler,
  createSchedulerHealthJob,
} from "./scheduler";

export type {
  LocalMemorySchedulerOptions,
  SchedulerJobDefinition,
  SchedulerJobSnapshot,
  SchedulerJobStatus,
  SchedulerRunContext,
  SchedulerStatusSnapshot,
} from "./scheduler";
