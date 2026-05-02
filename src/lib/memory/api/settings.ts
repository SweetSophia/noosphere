/**
 * RecallSettings persistence helpers.
 *
 * Provides database read/write for the RecallSettings singleton.
 * Settings are stored in a single row with id="singleton".
 *
 * @module memory/api/settings
 */

import { Prisma } from "@prisma/client";
import {
  DEFAULT_RECALL_SETTINGS,
  mergeRecallSettings,
  normalizeRecallSettings,
  type RecallSettings,
} from "@/lib/memory/settings";
import type { BudgetVerbosity } from "@/lib/memory/budget";
import type { ConflictStrategy } from "@/lib/memory/conflict";
import type { DeduplicationStrategy } from "@/lib/memory/dedup";

// ─── Database row shape ──────────────────────────────────────────────────────

interface RecallSettingsRow {
  id: string;
  autoRecallEnabled: boolean;
  maxInjectedMemories: number;
  maxInjectedTokens: number;
  recallVerbosity: string;
  summaryFirst: boolean;
  deduplicationStrategy: string;
  enabledProviders: string[];
  providerPriorityWeights: Prisma.JsonValue;
  conflictStrategy: string;
  conflictThreshold: number;
  updatedAt: Date;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Map a database row to a RecallSettings object.
 * Returns null if the row is null.
 */
function rowToRecallSettings(row: RecallSettingsRow | null): RecallSettings | null {
  if (!row) return null;

  return normalizeRecallSettings({
    autoRecallEnabled: row.autoRecallEnabled,
    maxInjectedMemories: row.maxInjectedMemories,
    maxInjectedTokens: row.maxInjectedTokens,
    recallVerbosity: row.recallVerbosity as BudgetVerbosity,
    deduplicationStrategy: row.deduplicationStrategy as DeduplicationStrategy,
    enabledProviders: row.enabledProviders,
    providerPriorityWeights: (row.providerPriorityWeights as Record<string, number>) ?? {},
    summaryFirst: row.summaryFirst,
    conflictStrategy: row.conflictStrategy as ConflictStrategy,
    conflictThreshold: row.conflictThreshold,
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch current RecallSettings from the database.
 *
 * - If a row exists, returns normalized settings (defaults filled in for any missing fields).
 * - If no row exists, returns the hardcoded DEFAULT_RECALL_SETTINGS.
 *
 * This function does NOT create a row — the caller decides when to initialize.
 */
export async function getRecallSettingsFromDB(): Promise<RecallSettings> {
  const { prisma } = await import("@/lib/prisma");

  const row = await prisma.recallSettings.findUnique({
    where: { id: "singleton" },
  });

  const settings = rowToRecallSettings(row);
  return settings ?? { ...DEFAULT_RECALL_SETTINGS };
}

/**
 * Upsert (insert or update) RecallSettings in the database.
 *
 * - Merges incoming partial settings with existing settings using mergeRecallSettings().
 * - Creates the singleton row if it doesn't exist.
 * - Returns the full normalized settings after the operation.
 *
 * @param updates - Partial settings to merge into existing settings
 */
export async function upsertRecallSettings(
  updates: Partial<RecallSettings>,
): Promise<RecallSettings> {
  const { prisma } = await import("@/lib/prisma");

  // Get current settings (from DB or defaults)
  const current = await getRecallSettingsFromDB();

  // Merge: existing values fill gaps, incoming values override
  const merged = mergeRecallSettings(current, updates);

  await prisma.recallSettings.upsert({
    where: { id: "singleton" },
    update: {
      autoRecallEnabled: merged.autoRecallEnabled,
      maxInjectedMemories: merged.maxInjectedMemories,
      maxInjectedTokens: merged.maxInjectedTokens,
      recallVerbosity: merged.recallVerbosity,
      summaryFirst: merged.summaryFirst,
      deduplicationStrategy: merged.deduplicationStrategy,
      enabledProviders: merged.enabledProviders,
      providerPriorityWeights: merged.providerPriorityWeights,
      conflictStrategy: merged.conflictStrategy,
      conflictThreshold: merged.conflictThreshold,
    },
    create: {
      id: "singleton",
      autoRecallEnabled: merged.autoRecallEnabled,
      maxInjectedMemories: merged.maxInjectedMemories,
      maxInjectedTokens: merged.maxInjectedTokens,
      recallVerbosity: merged.recallVerbosity,
      summaryFirst: merged.summaryFirst,
      deduplicationStrategy: merged.deduplicationStrategy,
      enabledProviders: merged.enabledProviders,
      providerPriorityWeights: merged.providerPriorityWeights,
      conflictStrategy: merged.conflictStrategy,
      conflictThreshold: merged.conflictThreshold,
    },
  });

  return merged;
}
