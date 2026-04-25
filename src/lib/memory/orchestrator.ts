import type {
  MemoryProvider,
  MemoryProviderConfig,
  MemoryProviderSearchOptions,
} from "./provider";
import { normalizeMemoryProviderConfig } from "./provider";
import {
  defineMemoryResult,
  estimateMemoryTokens,
  normalizeMemoryScore,
} from "./types";
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

  /** Effective token budget (auto mode). */
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
  private readonly globalResultCap: number;
  private readonly autoRecallTokenBudget: number;
  private readonly concurrency: number;

  constructor(options: RecallOrchestratorOptions) {
    if (!options.providers || options.providers.length === 0) {
      throw new Error("RecallOrchestrator requires at least one provider.");
    }

    this.providers = options.providers;
    this.globalResultCap =
      options.globalResultCap ?? DEFAULT_GLOBAL_RESULT_CAP;
    this.autoRecallTokenBudget =
      options.autoRecallTokenBudget ?? DEFAULT_AUTO_RECALL_TOKEN_BUDGET;
    this.concurrency = options.concurrency ?? options.providers.length;
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

    // Apply global cap.
    const capped = ranked.slice(0, effectiveCap);

    // Estimate tokens for auto-recall budget.
    const budgeted =
      query.mode === "auto" && effectiveBudget !== undefined
        ? this.applyTokenBudget(capped, effectiveBudget)
        : capped;

    // Build prompt injection text for auto mode.
    const promptInjectionText =
      query.mode === "auto"
        ? this.formatPromptInjection(budgeted, query.query)
        : undefined;

    return {
      results: budgeted,
      totalBeforeCap,
      mode: query.mode,
      tokenBudgetUsed: effectiveBudget,
      promptInjectionText,
      providerMeta: providerResults.map((pr) => ({
        providerId: pr.providerId,
        resultCount: pr.results.length,
        enabled: true,
        error: pr.error,
        durationMs: pr.durationMs,
      })),
    };
  }

  // ─── Fan-out ───────────────────────────────────────────────────────────

  private async fanOut(
    query: RecallQuery,
  ): Promise<ProviderFanOutResult[]> {
    const entries = this.providers
      .map((entry) => {
        const config = normalizeMemoryProviderConfig({
          ...entry.provider.descriptor.defaultConfig,
          ...entry.config,
        });

        if (!config.enabled) {
          return null;
        }

        // Auto-recall gating: skip providers that can't auto-recall when in auto mode.
        if (
          query.mode === "auto" &&
          !entry.provider.descriptor.capabilities.autoRecall
        ) {
          return null;
        }

        return { entry, config };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    // Execute all queries concurrently (future: respect concurrency limit).
    const results = await Promise.allSettled(
      entries.map(async ({ entry, config }) => {
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
          const durationMs = Math.round(performance.now() - start);

          return {
            providerId: entry.provider.descriptor.id,
            results: raw,
            durationMs,
          };
        } catch (err) {
          const durationMs = Math.round(performance.now() - start);
          return {
            providerId: entry.provider.descriptor.id,
            results: [],
            durationMs,
            error:
              err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );

    return results.map((r) =>
      r.status === "fulfilled"
        ? r.value
        : {
            providerId: "unknown",
            results: [],
            durationMs: 0,
            error: r.reason?.message ?? String(r.reason),
          },
    );
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

    // Look up provider priority weight (respect config override).
    const entry = this.providers.find(
      (e) => e.provider.descriptor.id === providerId,
    );
    const defaultWeight = entry?.provider.descriptor.defaultConfig.priorityWeight ?? 1;
    const overrideWeight = entry?.config?.priorityWeight;
    const weight =
      overrideWeight !== undefined ? overrideWeight : defaultWeight;

    const raw =
      COMPOSITE_WEIGHTS.relevance * relevance +
      COMPOSITE_WEIGHTS.confidence * confidence +
      COMPOSITE_WEIGHTS.recency * recency +
      COMPOSITE_WEIGHTS.curation * curation;

    // Apply provider weight as a multiplier.
    return normalizeMemoryScore(raw * weight);
  }

  // ─── Token budget ─────────────────────────────────────────────────────

  private applyTokenBudget(
    results: RecallResultRanked[],
    budget: number,
  ): RecallResultRanked[] {
    const budgeted: RecallResultRanked[] = [];
    let remaining = budget;

    for (const result of results) {
      const tokens = result.tokenEstimate ?? estimateMemoryTokens(result.content);

      if (tokens > remaining) {
        // Try summary instead if it fits.
        const summaryTokens = result.summary
          ? estimateMemoryTokens(result.summary)
          : tokens;

        if (summaryTokens <= remaining) {
          // Use summary-only version.
          budgeted.push({
            ...result,
            content: result.summary!,
            tokenEstimate: summaryTokens,
          });
          remaining -= summaryTokens;
          continue;
        }

        // Neither fits — stop.
        break;
      }

      budgeted.push(result);
      remaining -= tokens;
    }

    return budgeted;
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
  error?: string;
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

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createRecallOrchestrator(
  options: RecallOrchestratorOptions,
): RecallOrchestrator {
  return new RecallOrchestrator(options);
}
