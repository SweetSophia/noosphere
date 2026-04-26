import type {
  MemoryProvider,
  MemoryProviderConfig,
  MemoryProviderSearchOptions,
} from "./provider";
import { ContextBudgetManager } from "./budget";
import {
  getEffectiveAutoRecall,
  normalizeMemoryProviderConfig,
} from "./provider";
import { normalizeMemoryScore } from "./types";
import type { MemoryResult, MemoryScore } from "./types";

// ─── Types ──────────────────────────────────────────────────────────────────

export type RecallMode = "auto" | "inspection";

export interface RecallOrchestratorProviderEntry {
  provider: MemoryProvider;
  config?: Partial<MemoryProviderConfig>;
}

export interface RecallOrchestratorOptions {
  /** Registered providers in priority order. */
  providers: RecallOrchestratorProviderEntry[];

  /** Global maximum number of results across all providers. */
  globalResultCap?: number;

  /** Token budget for auto-recall prompt injection output. */
  autoRecallTokenBudget?: number;

  /** Maximum concurrent provider queries. Default: all at once. */
  concurrency?: number;
}

export interface RecallQuery {
  /** The search query string. */
  query: string;

  /** Recall mode affects output format and budget behavior. */
  mode: RecallMode;

  /** Per-query token budget override (auto mode only). */
  tokenBudget?: number;

  /** Per-query result cap override. */
  resultCap?: number;

  /** Abort signal. */
  signal?: AbortSignal;

  /** Scope hint passed through to providers. */
  scope?: string;
}

export interface RecallResultRanked extends MemoryResult {
  /** Cross-provider rank (1 = best). */
  rank: number;

  /** Orchestrator-level composite score used for ranking. */
  compositeScore: number;

  /** Provider-local score breakdown. */
  providerScores: Record<string, MemoryScore | undefined>;

  /** Which provider this result came from. */
  providerId: string;
}

export interface RecallResponse {
  /** Ordered results (best first). */
  results: RecallResultRanked[];

  /** Total results before cap was applied. */
  totalBeforeCap: number;

  /** Effective mode used. */
  mode: RecallMode;

  /** Estimated tokens consumed after budget enforcement (auto mode). */
  tokenBudgetUsed?: number;

  /** Formatted prompt injection text (auto mode only). */
  promptInjectionText?: string;

  /** Per-provider query metadata. */
  providerMeta: RecallProviderMeta[];
}

export interface RecallProviderMeta {
  providerId: string;
  resultCount: number;
  enabled: boolean;
  error?: string;
  durationMs: number;
  skippedReason?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_GLOBAL_RESULT_CAP = 20;
const DEFAULT_AUTO_RECALL_TOKEN_BUDGET = 2000;
const COMPOSITE_WEIGHTS = {
  relevance: 0.4,
  confidence: 0.25,
  recency: 0.2,
  curation: 0.15,
} as const;

const CURATION_SCORE_MAP: Record<string, number> = {
  curated: 1.0,
  reviewed: 0.7,
  ephemeral: 0.3,
};

// ─── Orchestrator ────────────────────────────────────────────────────────────

export class RecallOrchestrator {
  private readonly providers: RecallOrchestratorProviderEntry[];
  private readonly providerWeights: Map<string, number>;
  private readonly globalResultCap: number;
  private readonly autoRecallTokenBudget: number;
  private readonly concurrency: number;

  constructor(options: RecallOrchestratorOptions) {
    if (!options.providers || options.providers.length === 0) {
      throw new Error("RecallOrchestrator requires at least one provider.");
    }

    assertUniqueProviderIds(options.providers);

    this.providers = options.providers;
    this.providerWeights = buildProviderWeightMap(options.providers);
    this.globalResultCap =
      options.globalResultCap ?? DEFAULT_GLOBAL_RESULT_CAP;
    this.autoRecallTokenBudget =
      options.autoRecallTokenBudget ?? DEFAULT_AUTO_RECALL_TOKEN_BUDGET;
    this.concurrency = normalizePositiveInteger(
      options.concurrency,
      options.providers.length,
    );
  }

  async recall(query: RecallQuery): Promise<RecallResponse> {
    const effectiveCap =
      query.resultCap ?? this.globalResultCap;
    const effectiveBudget =
      query.mode === "auto"
        ? (query.tokenBudget ?? this.autoRecallTokenBudget)
        : undefined;

    // Fan out to all enabled providers concurrently.
    const providerResults = await this.fanOut(query);

    // Merge, score, and rank all results.
    const ranked = this.rankResults(providerResults);

    const totalBeforeCap = ranked.length;

    const budgeted =
      query.mode === "auto" && effectiveBudget !== undefined
        ? applyRecallBudget(ranked, effectiveCap, effectiveBudget)
        : { results: ranked.slice(0, effectiveCap), tokenBudgetUsed: undefined };

    // Build prompt injection text for auto mode.
    const promptInjectionText =
      query.mode === "auto"
        ? this.formatPromptInjection(budgeted.results, query.query)
        : undefined;

    return {
      results: budgeted.results,
      totalBeforeCap,
      mode: query.mode,
      tokenBudgetUsed: budgeted.tokenBudgetUsed,
      promptInjectionText,
      providerMeta: providerResults.map((pr) => ({
        providerId: pr.providerId,
        resultCount: pr.results.length,
        enabled: pr.enabled,
        error: pr.error,
        durationMs: pr.durationMs,
        skippedReason: pr.skippedReason,
      })),
    };
  }

  // ─── Fan-out ───────────────────────────────────────────────────────────

  private async fanOut(
    query: RecallQuery,
  ): Promise<ProviderFanOutResult[]> {
    const skipped: ProviderFanOutResult[] = [];
    const entries: RunnableProviderEntry[] = [];

    for (const [order, entry] of this.providers.entries()) {
      const config = normalizeMemoryProviderConfig({
        ...entry.provider.descriptor.defaultConfig,
        ...entry.config,
      });
      const providerId = entry.provider.descriptor.id;

      if (!config.enabled) {
        skipped.push(buildSkippedProviderResult(providerId, order, "disabled"));
        continue;
      }

      if (
        query.mode === "auto" &&
        !getEffectiveAutoRecall(entry.provider.descriptor.capabilities, config)
      ) {
        skipped.push(
          buildSkippedProviderResult(providerId, order, "auto-recall-disabled"),
        );
        continue;
      }

      entries.push({ entry, config, providerId, order });
    }

    const queried = await runWithConcurrency(entries, this.concurrency, (entry) =>
      this.queryProvider(entry, query),
    );

    return [...queried, ...skipped].sort((left, right) => left.order - right.order);
  }

  private async queryProvider(
    { entry, config, providerId, order }: RunnableProviderEntry,
    query: RecallQuery,
  ): Promise<ProviderFanOutResult> {
    const start = performance.now();

    try {
      const searchOptions: MemoryProviderSearchOptions = {
        limit: config.maxResults,
        scope: query.scope,
        autoRecall: query.mode === "auto",
        config,
        signal: query.signal,
      };

      const raw = await entry.provider.search(query.query, searchOptions);

      return {
        providerId,
        results: raw,
        durationMs: elapsedMs(start),
        enabled: true,
        order,
      };
    } catch (err) {
      return {
        providerId,
        results: [],
        durationMs: elapsedMs(start),
        enabled: true,
        order,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ─── Ranking ───────────────────────────────────────────────────────────

  private rankResults(
    providerResults: ProviderFanOutResult[],
  ): RecallResultRanked[] {
    const allResults: ScorableResult[] = [];

    for (const pr of providerResults) {
      for (const result of pr.results) {
        const compositeScore = this.computeCompositeScore(result, pr.providerId);
        allResults.push({
          result,
          providerId: pr.providerId,
          compositeScore,
        });
      }
    }

    // Sort by composite score descending, then by relevance descending as tiebreaker.
    allResults.sort((a, b) => {
      const scoreDiff = b.compositeScore - a.compositeScore;
      if (Math.abs(scoreDiff) > 0.001) return scoreDiff;
      return (b.result.relevanceScore ?? 0) - (a.result.relevanceScore ?? 0);
    });

    // Deduplicate by canonicalRef.
    const seen = new Set<string>();
    const deduped: ScorableResult[] = [];
    for (const item of allResults) {
      const key = item.result.canonicalRef ?? `${item.providerId}:${item.result.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }

    return deduped.map((item, index) =>
      ({
        ...item.result,
        rank: index + 1,
        compositeScore: item.compositeScore,
        providerScores: {
          relevance: item.result.relevanceScore,
          confidence: item.result.confidenceScore,
          recency: item.result.recencyScore,
        },
        providerId: item.providerId,
      }) as RecallResultRanked,
    );
  }

  private computeCompositeScore(
    result: MemoryResult,
    providerId: string,
  ): number {
    const relevance = result.relevanceScore ?? 0;
    const confidence = result.confidenceScore ?? 0;
    const recency = result.recencyScore ?? 0;
    const curation =
      CURATION_SCORE_MAP[result.curationLevel ?? ""] ?? 0.5;

    const weight = this.providerWeights.get(providerId) ?? 1;

    const raw =
      COMPOSITE_WEIGHTS.relevance * relevance +
      COMPOSITE_WEIGHTS.confidence * confidence +
      COMPOSITE_WEIGHTS.recency * recency +
      COMPOSITE_WEIGHTS.curation * curation;

    // Apply provider weight as a multiplier.
    return normalizeMemoryScore(raw * weight);
  }

  // ─── Prompt injection formatting ──────────────────────────────────────

  private formatPromptInjection(
    results: RecallResultRanked[],
    query: string,
  ): string {
    if (results.length === 0) {
      return "";
    }

    const lines: string[] = [
      `<recall query="${escapeXmlAttr(query)}">`,
    ];

    for (const result of results) {
      const source = result.providerId;
      const title = result.title ? ` title="${escapeXmlAttr(result.title)}"` : "";
      const ref = result.canonicalRef
        ? ` ref="${escapeXmlAttr(result.canonicalRef)}"`
        : "";

      lines.push(
        `  <memory source="${escapeXmlAttr(source)}"${title}${ref}>`,
        `    ${escapeXmlContent(result.content)}`,
        `  </memory>`,
      );
    }

    lines.push("</recall>");
    return lines.join("\n");
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface ProviderFanOutResult {
  providerId: string;
  results: MemoryResult[];
  durationMs: number;
  enabled: boolean;
  order: number;
  error?: string;
  skippedReason?: string;
}

interface RunnableProviderEntry {
  entry: RecallOrchestratorProviderEntry;
  config: MemoryProviderConfig;
  providerId: string;
  order: number;
}

interface ScorableResult {
  result: MemoryResult;
  providerId: string;
  compositeScore: number;
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlContent(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function assertUniqueProviderIds(
  providers: RecallOrchestratorProviderEntry[],
): void {
  const seen = new Set<string>();
  for (const entry of providers) {
    const providerId = entry.provider.descriptor.id;
    if (seen.has(providerId)) {
      throw new Error(`Duplicate memory provider id: ${providerId}`);
    }
    seen.add(providerId);
  }
}

function buildProviderWeightMap(
  providers: RecallOrchestratorProviderEntry[],
): Map<string, number> {
  return new Map(
    providers.map((entry) => {
      const config = normalizeMemoryProviderConfig({
        ...entry.provider.descriptor.defaultConfig,
        ...entry.config,
      });
      return [entry.provider.descriptor.id, config.priorityWeight];
    }),
  );
}

function buildSkippedProviderResult(
  providerId: string,
  order: number,
  skippedReason: string,
): ProviderFanOutResult {
  return {
    providerId,
    results: [],
    durationMs: 0,
    enabled: false,
    order,
    skippedReason,
  };
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += concurrency) {
    const batch = items.slice(index, index + concurrency);
    results.push(...(await Promise.all(batch.map(worker))));
  }
  return results;
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return Math.max(1, Math.floor(fallback));
  }

  return Math.max(1, Math.floor(value));
}

function elapsedMs(start: number): number {
  return Math.round(performance.now() - start);
}

function applyRecallBudget(
  results: RecallResultRanked[],
  maxResults: number,
  maxTokens: number,
): { results: RecallResultRanked[]; tokenBudgetUsed: number } {
  const budget = new ContextBudgetManager({ maxResults, maxTokens });
  const budgeted = budget.apply(results);

  return {
    results: budgeted.results.map((entry) => ({
      ...entry.result,
      tokenEstimate: entry.tokenEstimate,
    })),
    tokenBudgetUsed: budgeted.tokensUsed,
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createRecallOrchestrator(
  options: RecallOrchestratorOptions,
): RecallOrchestrator {
  return new RecallOrchestrator(options);
}
