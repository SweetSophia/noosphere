/**
 * Context Budget Manager — strict prompt-budget controls for auto-recall.
 *
 * Encapsulates budget policy (token limits, result caps, verbosity,
 * summary-first preference) so the orchestrator delegates budget decisions
 * here instead of handling them inline.
 *
 * @see github.com/SweetSophia/noosphere/issues/11
 */

import { estimateMemoryTokens } from "./types";
import type { MemoryResult } from "./types";

// ─── Types ──────────────────────────────────────────────────────────────────

export type BudgetVerbosity = "minimal" | "standard" | "detailed";

export interface ContextBudgetConfig {
  /** Hard cap on total tokens emitted in auto-recall output. Default: 2000. */
  maxTokens?: number;

  /** Hard cap on number of memory results, regardless of token budget. Default: 20. */
  maxResults?: number;

  /** When true, prefer summary content over full content to fit more results. Default: true. */
  summaryFirst?: boolean;

  /**
   * Verbosity controls how much detail each result gets.
   * - "minimal": summary only, titles omitted from prompt injection
   * - "standard": summary preferred, titles included
   * - "detailed": full content, titles + refs included
   * Default: "standard".
   */
  verbosity?: BudgetVerbosity;
}

export interface BudgetResult<T extends MemoryResult> {
  /** Results that fit within the budget. */
  results: BudgetEntry<T>[];

  /** Total results before budget was applied. */
  totalBeforeBudget: number;

  /** Estimated tokens consumed by the emitted results. */
  tokensUsed: number;

  /** Results that were trimmed (downgraded from content to summary). */
  trimmedCount: number;

  /** Results that were dropped entirely because they didn't fit. */
  droppedCount: number;
}

export interface BudgetEntry<T extends MemoryResult> {
  /** The (possibly summary-substituted) result. */
  result: T;

  /** Token estimate for the emitted content. */
  tokenEstimate: number;

  /** Whether the entry was downgraded from full content to summary. */
  usedSummary: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_SUMMARY_FIRST = true;
const DEFAULT_VERBOSITY: BudgetVerbosity = "standard";

/** In minimal mode, cap each individual result's tokens to this. */
const MINIMAL_PER_RESULT_TOKEN_CAP = 60;

// ─── Budget Manager ──────────────────────────────────────────────────────────

export class ContextBudgetManager {
  readonly maxTokens: number;
  readonly maxResults: number;
  readonly summaryFirst: boolean;
  readonly verbosity: BudgetVerbosity;

  constructor(config: ContextBudgetConfig = {}) {
    this.maxTokens = normalizePositiveFinite(config.maxTokens, DEFAULT_MAX_TOKENS);
    this.maxResults = normalizePositiveFinite(config.maxResults, DEFAULT_MAX_RESULTS);
    this.summaryFirst = config.summaryFirst ?? DEFAULT_SUMMARY_FIRST;
    this.verbosity = config.verbosity ?? DEFAULT_VERBOSITY;
  }

  /**
   * Apply budget constraints to a ranked result list.
   *
   * Returns the subset that fits, along with accounting metadata.
   * The input is assumed to already be ordered by relevance (best first).
   */
  apply<T extends MemoryResult>(results: T[]): BudgetResult<T> {
    const totalBeforeBudget = results.length;

    // Phase 1: hard cap on count.
    const capped = results.slice(0, this.maxResults);

    // Phase 2: token budget with summary-first preference.
    const budgeted: BudgetEntry<T>[] = [];
    let tokensUsed = 0;
    let trimmedCount = 0;

    for (const result of capped) {
      const content = this.selectContent(result);
      const tokens = estimateMemoryTokens(content);

      // Check if this single result exceeds the per-result cap in minimal mode.
      const effectiveTokens = this.effectiveTokenCap(tokens, content, result);

      if (tokensUsed + effectiveTokens > this.maxTokens) {
        // Try summary fallback if we haven't already used it.
        if (content === result.content && result.summary) {
          const summaryTokens = estimateMemoryTokens(result.summary);
          const effectiveSummary = this.effectiveTokenCap(
            summaryTokens,
            result.summary,
            result,
          );

          if (tokensUsed + effectiveSummary <= this.maxTokens) {
            budgeted.push({
              result,
              tokenEstimate: effectiveSummary,
              usedSummary: true,
            });
            tokensUsed += effectiveSummary;
            trimmedCount++;
            continue;
          }
        }
        // Doesn't fit — skip. Remaining results won't fit either (ordered
        // by rank, so they're equal or larger).
        break;
      }

      budgeted.push({
        result,
        tokenEstimate: effectiveTokens,
        usedSummary: content !== result.content,
      });
      tokensUsed += effectiveTokens;
      if (content !== result.content) {
        trimmedCount++;
      }
    }

    const acceptedCount = budgeted.length;
    const droppedCount = totalBeforeBudget - acceptedCount;

    return {
      results: budgeted,
      totalBeforeBudget,
      tokensUsed,
      trimmedCount,
      droppedCount,
    };
  }

  /**
   * Get the effective content string for a result based on verbosity
   * and summary-first settings.
   */
  getContent<T extends MemoryResult>(result: T): string {
    return this.selectContent(result);
  }

  // ─── Private ───────────────────────────────────────────────────────────

  private selectContent<T extends MemoryResult>(result: T): string {
    if (this.summaryFirst && result.summary) {
      return result.summary;
    }
    return result.content;
  }

  /**
   * In minimal verbosity, truncate each result to a token cap.
   * Returns the effective token count (may be less than raw estimate
   * if the content was truncated).
   */
  private effectiveTokenCap(
    tokens: number,
    _content: string,
    _result: MemoryResult,
  ): number {
    if (this.verbosity === "minimal" && tokens > MINIMAL_PER_RESULT_TOKEN_CAP) {
      return MINIMAL_PER_RESULT_TOKEN_CAP;
    }
    return tokens;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizePositiveFinite(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return Math.max(1, Math.floor(fallback));
  }
  return Math.max(1, Math.floor(value));
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createContextBudgetManager(
  config?: ContextBudgetConfig,
): ContextBudgetManager {
  return new ContextBudgetManager(config);
}
