import {
  DEFAULT_RECALL_SETTINGS,
  normalizeRecallSettings,
  type RecallSettings,
} from "@/lib/memory/settings";
import {
  normalizeMemoryProviderConfig,
  type MemoryProviderConfig,
  type MemoryProviderDescriptor,
} from "@/lib/memory/provider";

export interface MemoryProviderStatus {
  id: string;
  displayName?: string;
  sourceType: string;
  enabled: boolean;
  allowAutoRecall: boolean;
  priorityWeight: number;
  maxResults?: number;
  capabilities: {
    search: boolean;
    getById: boolean;
    score: boolean;
    autoRecall: boolean;
  };
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
  >;
}

interface MemoryProviderStatusSource {
  descriptor: MemoryProviderDescriptor;
  config?: Partial<MemoryProviderConfig>;
}

const DEFAULT_NOOSPHERE_DESCRIPTOR: MemoryProviderDescriptor = {
  id: "noosphere",
  displayName: "Noosphere",
  sourceType: "noosphere",
  defaultConfig: {
    enabled: true,
    priorityWeight: 1.25,
    maxResults: 10,
    allowAutoRecall: true,
  },
  capabilities: {
    search: true,
    getById: true,
    score: true,
    autoRecall: true,
  },
  metadata: {
    contentType: "article",
  },
};

export function getDefaultMemoryProviderStatusSources(): MemoryProviderStatusSource[] {
  return [{ descriptor: DEFAULT_NOOSPHERE_DESCRIPTOR }];
}

export function getMemoryStatusSnapshot(
  options: {
    now?: Date;
    providers?: MemoryProviderStatusSource[];
    settings?: Partial<RecallSettings>;
  } = {},
): MemoryStatusSnapshot {
  const providers = options.providers ?? getDefaultMemoryProviderStatusSources();
  const settings = normalizeRecallSettings({
    ...DEFAULT_RECALL_SETTINGS,
    ...options.settings,
  });

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
    allowAutoRecall: config.allowAutoRecall !== false,
    priorityWeight: config.priorityWeight,
    maxResults: config.maxResults,
    capabilities: { ...descriptor.capabilities },
  };
}
