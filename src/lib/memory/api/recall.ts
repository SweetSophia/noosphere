import {
  createRecallOrchestrator,
  type RecallMode,
  type RecallOrchestratorProviderEntry,
  type RecallProviderMeta,
  type RecallResponse,
  type RecallResultRanked,
} from "@/lib/memory/orchestrator";
import {
  DEFAULT_RECALL_SETTINGS,
  normalizeRecallSettings,
  toConflictConfig,
  type RecallSettings,
} from "@/lib/memory/settings";
import type { DeduplicationStats } from "@/lib/memory/dedup";
import type { ConflictSignal, ConflictStats } from "@/lib/memory/conflict";

export const MEMORY_RECALL_LIMITS = {
  maxResultCap: 10,
  maxTokenBudget: 2000,
  timeoutMs: 5000,
  maxQueryLength: 1000,
} as const;

export const MEMORY_RECALL_DEFAULT_AUTO_PROVIDERS = ["noosphere"] as const;

export interface MemoryRecallRequest {
  query: string;
  mode?: RecallMode;
  resultCap?: number;
  tokenBudget?: number;
  scope?: string;
  providers?: string[];
}

export interface MemoryRecallResponse {
  results: RecallResultRanked[];
  totalBeforeCap: number;
  mode: RecallMode;
  tokenBudgetUsed?: number;
  promptInjectionText?: string;
  providerMeta: RecallProviderMeta[];
  dedupStats?: DeduplicationStats;
  conflicts?: ConflictSignal[];
  conflictStats?: ConflictStats;
}

export interface MemoryRecallExecutionOptions {
  providers?: RecallOrchestratorProviderEntry[];
  settings?: Partial<RecallSettings>;
  timeoutMs?: number;
}

export type MemoryRecallValidationResult =
  | {
      ok: true;
      request: Required<
        Pick<MemoryRecallRequest, "query" | "mode" | "resultCap" | "tokenBudget">
      > &
        Pick<MemoryRecallRequest, "scope" | "providers">;
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

export async function getDefaultMemoryRecallProviders(): Promise<RecallOrchestratorProviderEntry[]> {
  const { createNoosphereProvider } = await import("@/lib/memory/noosphere");
  return [{ provider: createNoosphereProvider() }];
}

export function validateMemoryRecallRequest(input: unknown): MemoryRecallValidationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, status: 400, error: "Request body must be an object" };
  }

  const body = input as Record<string, unknown>;
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    return { ok: false, status: 400, error: "query is required" };
  }
  if (query.length > MEMORY_RECALL_LIMITS.maxQueryLength) {
    return { ok: false, status: 400, error: "query is too long" };
  }

  const mode = body.mode === undefined ? "inspection" : body.mode;
  if (mode !== "auto" && mode !== "inspection") {
    return { ok: false, status: 400, error: "mode must be auto or inspection" };
  }

  const resultCap = clampPositiveInteger(
    body.resultCap,
    DEFAULT_RECALL_SETTINGS.maxInjectedMemories,
    MEMORY_RECALL_LIMITS.maxResultCap,
  );
  const tokenBudget = clampPositiveInteger(
    body.tokenBudget,
    DEFAULT_RECALL_SETTINGS.maxInjectedTokens,
    MEMORY_RECALL_LIMITS.maxTokenBudget,
  );

  const scope = body.scope === undefined
    ? undefined
    : typeof body.scope === "string" && body.scope.trim()
      ? body.scope.trim()
      : undefined;

  let providers: string[] | undefined;
  if (body.providers !== undefined) {
    if (!Array.isArray(body.providers)) {
      return { ok: false, status: 400, error: "providers must be an array of provider IDs" };
    }
    if (body.providers.some((provider: unknown) => typeof provider !== "string")) {
      return { ok: false, status: 400, error: "providers must be an array of provider ID strings" };
    }
    providers = [
      ...new Set(
        (body.providers as string[])
          .map((provider) => provider.trim())
          .filter(Boolean),
      ),
    ];
    if (providers.length === 0) {
      return { ok: false, status: 400, error: "providers must contain at least one non-empty provider ID" };
    }
  }

  return {
    ok: true,
    request: {
      query,
      mode,
      resultCap,
      tokenBudget,
      scope,
      providers,
    },
  };
}

export async function executeMemoryRecallRequest(
  input: unknown,
  options: MemoryRecallExecutionOptions = {},
): Promise<{ status: number; body: MemoryRecallResponse | { error: string } }> {
  const validation = validateMemoryRecallRequest(input);
  if (!validation.ok) {
    return { status: validation.status, body: { error: validation.error } };
  }

  const settings = normalizeRecallSettings(options.settings);
  const providerEntries = options.providers ?? await getDefaultMemoryRecallProviders();
  const requestedProviders =
    validation.request.providers ??
    (validation.request.mode === "auto"
      ? [...MEMORY_RECALL_DEFAULT_AUTO_PROVIDERS]
      : undefined);
  const providers = filterProviders(
    providerEntries,
    requestedProviders,
  );

  if (!providers.ok) {
    return { status: 400, body: { error: providers.error } };
  }

  const timeoutMs = clampPositiveInteger(
    options.timeoutMs,
    MEMORY_RECALL_LIMITS.timeoutMs,
    Number.MAX_SAFE_INTEGER,
  );
  const controller = new AbortController();

  try {
    const orchestrator = createRecallOrchestrator({
      providers: providers.entries,
      globalResultCap: Math.min(settings.maxInjectedMemories, MEMORY_RECALL_LIMITS.maxResultCap),
      autoRecallTokenBudget: Math.min(settings.maxInjectedTokens, MEMORY_RECALL_LIMITS.maxTokenBudget),
      deduplication: {
        strategy: settings.deduplicationStrategy,
        providerPriority: settings.enabledProviders,
      },
      conflict: toConflictConfig(settings),
    });

    const response = await withTimeout(
      orchestrator.recall({
        query: validation.request.query,
        mode: validation.request.mode,
        resultCap: Math.min(validation.request.resultCap, Math.min(settings.maxInjectedMemories, MEMORY_RECALL_LIMITS.maxResultCap)),
        tokenBudget: Math.min(validation.request.tokenBudget, Math.min(settings.maxInjectedTokens, MEMORY_RECALL_LIMITS.maxTokenBudget)),
        scope: validation.request.scope,
        signal: controller.signal,
      }),
      timeoutMs,
      () => {
        controller.abort();
        return buildTimeoutResponse(
          validation.request.mode,
          providers.entries,
          timeoutMs,
        );
      },
    );

    return { status: 200, body: toMemoryRecallResponse(response) };
  } finally {
    controller.abort();
  }
}

function buildTimeoutResponse(
  mode: RecallMode,
  providers: RecallOrchestratorProviderEntry[],
  timeoutMs: number,
): RecallResponse {
  return {
    results: [],
    totalBeforeCap: 0,
    mode,
    tokenBudgetUsed: mode === "auto" ? 0 : undefined,
    promptInjectionText: mode === "auto" ? "" : undefined,
    providerMeta: providers.map((entry) => ({
      providerId: entry.provider.descriptor.id,
      resultCount: 0,
      enabled: true,
      error: "Memory recall timed out",
      durationMs: timeoutMs,
    })),
    dedupStats: { totalInput: 0, totalOutput: 0, collapsedTotal: 0 },
    conflictStats: {
      totalInput: 0,
      conflictingPairs: 0,
      resolved: 0,
      suppressed: 0,
      surfaced: 0,
    },
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(onTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function toMemoryRecallResponse(response: RecallResponse): MemoryRecallResponse {
  return {
    results: response.results,
    totalBeforeCap: response.totalBeforeCap,
    mode: response.mode,
    tokenBudgetUsed: response.tokenBudgetUsed,
    promptInjectionText:
      response.mode === "auto" ? response.promptInjectionText : undefined,
    providerMeta: response.providerMeta,
    dedupStats: response.dedupStats,
    conflicts: response.conflicts,
    conflictStats: response.conflictStats,
  };
}

function filterProviders(
  providers: RecallOrchestratorProviderEntry[],
  requested: string[] | undefined,
): { ok: true; entries: RecallOrchestratorProviderEntry[] } | { ok: false; error: string } {
  if (!requested || requested.length === 0) {
    return { ok: true, entries: providers };
  }

  const byId = new Map(
    providers.map((entry) => [entry.provider.descriptor.id, entry] as const),
  );
  const unknown = requested.filter((providerId) => !byId.has(providerId));
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown provider ID: ${unknown.join(", ")}` };
  }

  return {
    ok: true,
    entries: requested.map((providerId) => byId.get(providerId)!),
  };
}

function clampPositiveInteger(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return Math.min(Math.floor(fallback), max);
  }
  return Math.min(Math.max(1, Math.floor(value)), max);
}
