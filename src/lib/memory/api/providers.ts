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

/**
 * Substrings that must not appear in the serialized status snapshot.
 * Best-effort regression guard against accidentally including secret-like
 * field names in the snapshot output. Does not detect secret values,
 * misspellings, or non-English field names — not a security boundary.
 * Extracted to a constant so updates stay centralized and consistent.
 */
export const FORBIDDEN_SECRET_SUBSTRINGS = [
  "apikey",    // camelCase API key field
  "api_key",   // snake_case API key field
  "keyhash",   // hashed key reference
  "secret",    // generic secret
  "password",  // password field
] as const;

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
 * NOTE: This intentionally returns only the built-in Noosphere provider until
 * there is a provider registry or persisted memory-settings store to read from.
 * The snapshot builder stays DB-free, but the route itself still uses
 * DB-backed auth; do not claim the endpoint is fully database-independent.
 * In production with additional providers (e.g. hindsight), replace this
 * static source list with live configuration plus a graceful static fallback.
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
