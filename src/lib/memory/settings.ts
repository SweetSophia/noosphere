/**
 * User-configurable recall settings.
 *
 * Exposes recall behavior settings so that operators can control auto-recall,
 * budget limits, verbosity, and per-provider configuration without touching
 * code. Designed to be serializable (JSON) for storage or API transport.
 *
 * @module recall-settings
 */

import type { BudgetVerbosity } from "./budget";
import type { DeduplicationStrategy } from "./dedup";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RecallSettings {
  /** Whether automatic recall injection is enabled globally. */
  autoRecallEnabled: boolean;

  /** Maximum number of memories injected per auto-recall cycle. */
  maxInjectedMemories: number;

  /** Maximum estimated prompt tokens per auto-recall cycle. */
  maxInjectedTokens: number;

  /** Verbosity level for recall output. */
  recallVerbosity: BudgetVerbosity;

  /** Strategy for cross-provider deduplication. */
  deduplicationStrategy: DeduplicationStrategy;

  /** Ordered list of enabled provider IDs. Disabled providers are excluded. */
  enabledProviders: string[];

  /** Per-provider priority weights (provider ID → weight). */
  providerPriorityWeights: Record<string, number>;

  /**
   * Prefer summary over full content when both are available.
   * Overridden by verbosity in detailed/minimal modes.
   */
  summaryFirst: boolean;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_RECALL_SETTINGS: RecallSettings = {
  autoRecallEnabled: true,
  maxInjectedMemories: 20,
  maxInjectedTokens: 2000,
  recallVerbosity: "standard",
  deduplicationStrategy: "best-score",
  enabledProviders: [],
  providerPriorityWeights: {},
  summaryFirst: true,
};

// ─── Normalization ───────────────────────────────────────────────────────────

const VALID_VERBOSITIES: BudgetVerbosity[] = ["minimal", "standard", "detailed"];
const VALID_STRATEGIES: DeduplicationStrategy[] = ["best-score", "provider-priority", "most-recent"];

/**
 * Normalize and validate recall settings, filling in defaults for missing
 * or invalid values.
 */
export function normalizeRecallSettings(
  input: Partial<RecallSettings> = {},
): RecallSettings {
  const autoRecallEnabled =
    typeof input.autoRecallEnabled === "boolean"
      ? input.autoRecallEnabled
      : DEFAULT_RECALL_SETTINGS.autoRecallEnabled;

  const maxInjectedMemories = sanitizePositiveInt(
    input.maxInjectedMemories,
    DEFAULT_RECALL_SETTINGS.maxInjectedMemories,
  );

  const maxInjectedTokens = sanitizePositiveInt(
    input.maxInjectedTokens,
    DEFAULT_RECALL_SETTINGS.maxInjectedTokens,
  );

  const recallVerbosity: BudgetVerbosity =
    VALID_VERBOSITIES.includes(input.recallVerbosity as BudgetVerbosity)
      ? (input.recallVerbosity as BudgetVerbosity)
      : DEFAULT_RECALL_SETTINGS.recallVerbosity;

  const deduplicationStrategy: DeduplicationStrategy =
    VALID_STRATEGIES.includes(input.deduplicationStrategy as DeduplicationStrategy)
      ? (input.deduplicationStrategy as DeduplicationStrategy)
      : DEFAULT_RECALL_SETTINGS.deduplicationStrategy;

  const enabledProviders = Array.isArray(input.enabledProviders)
    ? input.enabledProviders.filter((p): p is string => typeof p === "string")
    : DEFAULT_RECALL_SETTINGS.enabledProviders;

  const providerPriorityWeights =
    input.providerPriorityWeights &&
    typeof input.providerPriorityWeights === "object" &&
    !Array.isArray(input.providerPriorityWeights)
      ? normalizePriorityWeights(input.providerPriorityWeights)
      : DEFAULT_RECALL_SETTINGS.providerPriorityWeights;

  const summaryFirst =
    typeof input.summaryFirst === "boolean"
      ? input.summaryFirst
      : DEFAULT_RECALL_SETTINGS.summaryFirst;

  return {
    autoRecallEnabled,
    maxInjectedMemories,
    maxInjectedTokens,
    recallVerbosity,
    deduplicationStrategy,
    enabledProviders,
    providerPriorityWeights,
    summaryFirst,
  };
}

/**
 * Merge user settings with an override layer (e.g. per-request overrides).
 * Override values take precedence; user settings fill the gaps.
 */
export function mergeRecallSettings(
  base: RecallSettings,
  overrides: Partial<RecallSettings>,
): RecallSettings {
  return normalizeRecallSettings({
    ...base,
    ...overrides,
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sanitizePositiveInt(
  value: unknown,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function normalizePriorityWeights(
  input: Record<string, unknown>,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      result[key] = value;
    }
  }
  return result;
}
