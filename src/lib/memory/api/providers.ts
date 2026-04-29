import {
  normalizeRecallSettings,
  type RecallSettings,
} from "@/lib/memory/settings";
import {
  getEffectiveAutoRecall,
  normalizeMemoryProviderConfig,
  type MemoryProviderCapabilities,
  type MemoryProviderConfig,
  type MemoryProviderDescriptor,
} from "@/lib/memory/provider";
import { NOOSPHERE_PROVIDER_DESCRIPTOR } from "@/lib/memory/noosphere-descriptor";
import type { MemorySourceType } from "@/lib/memory/types";

export interface MemoryProviderStatus {
  id: string;
  displayName?: string;
  sourceType: MemorySourceType;
  enabled: boolean;
  allowAutoRecall: boolean;
  priorityWeight: number;
  maxResults?: number;
  capabilities: MemoryProviderCapabilities;
}

export interface MemoryStatusSnapshot {
  ok: boolean;
  timestamp: string;
  providers: MemoryProviderStatus[];
  settings: Pick<
    RecallSettings,
    | "autoRecallEnabled"
    | "maxInjectedMemories"
    | "maxInjectedTokens"
    | "recallVerbosity"
    | "deduplicationStrategy"
    | "conflictStrategy"
    | "conflictThreshold"
    | "summaryFirst"
  >;
}

export interface MemoryProviderStatusSource {
  descriptor: MemoryProviderDescriptor;
  config?: Partial<MemoryProviderConfig>;
}

/**
 * Returns the static list of provider descriptors for the status snapshot.
 *
 * NOTE: This intentionally returns only the built-in Noosphere provider.
 * Returning live provider configs would require a database query; the status
 * endpoint deliberately avoids that dependency so it can respond even when
 * the database is unreachable. In production with additional providers (e.g.
 * hindsight), this function should be updated to reflect the active provider
 * landscape, or the status route should fall back gracefully.
 */
export function getDefaultMemoryProviderStatusSources(): MemoryProviderStatusSource[] {
  return [{ descriptor: NOOSPHERE_PROVIDER_DESCRIPTOR }];
}

export function getMemoryStatusSnapshot(
  options: {
    now?: Date;
    providers?: MemoryProviderStatusSource[];
    settings?: Partial<RecallSettings>;
  } = {},
): MemoryStatusSnapshot {
  const providers = options.providers ?? getDefaultMemoryProviderStatusSources();
  const settings = normalizeRecallSettings(options.settings);

  return {
    ok: true,
    timestamp: (options.now ?? new Date()).toISOString(),
    providers: providers.map(toProviderStatus),
    settings: {
      autoRecallEnabled: settings.autoRecallEnabled,
      maxInjectedMemories: settings.maxInjectedMemories,
      maxInjectedTokens: settings.maxInjectedTokens,
      recallVerbosity: settings.recallVerbosity,
      deduplicationStrategy: settings.deduplicationStrategy,
      conflictStrategy: settings.conflictStrategy,
      conflictThreshold: settings.conflictThreshold,
      summaryFirst: settings.summaryFirst,
    },
  };
}

function toProviderStatus(source: MemoryProviderStatusSource): MemoryProviderStatus {
  const descriptor = source.descriptor;
  const config = normalizeMemoryProviderConfig({
    ...descriptor.defaultConfig,
    ...source.config,
  });

  return {
    id: descriptor.id,
    displayName: descriptor.displayName,
    sourceType: descriptor.sourceType,
    enabled: config.enabled,
    allowAutoRecall: getEffectiveAutoRecall(descriptor.capabilities, config),
    priorityWeight: config.priorityWeight,
    maxResults: config.maxResults,
    capabilities: { ...descriptor.capabilities },
  };
}
