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

  /** Results whose emitted content was shortened or replaced by a summary. */
  trimmedCount: number;

  /** Results excluded by either max-result or token-budget enforcement. */
  droppedCount: number;

  /** Results excluded by the maxResults cap before token budgeting. */
  droppedByResultCap: number;

  /** Results excluded because they did not fit the token budget. */
  droppedByTokenBudget: number;
}

export interface BudgetEntry<T extends MemoryResult> {
  /** The result with content adjusted to the budgeted emitted content. */
  result: T;

  /** Token estimate for the emitted content. */
  tokenEstimate: number;

  /** Whether the emitted content is the result summary. */
  usedSummary: boolean;
}

interface ContentSelection {
  content: string;
  usedSummary: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_SUMMARY_FIRST = true;
const DEFAULT_VERBOSITY: BudgetVerbosity = "standard";

/** In minimal mode, cap each individual result's tokens to this. */
const MINIMAL_PER_RESULT_TOKEN_CAP = 60;
const MINIMAL_PER_RESULT_CHAR_CAP = MINIMAL_PER_RESULT_TOKEN_CAP * 4;

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
    this.verbosity = normalizeVerbosity(config.verbosity);
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
    const droppedByResultCap = Math.max(0, totalBeforeBudget - capped.length);

    // Phase 2: token budget with summary-first preference.
    const budgeted: BudgetEntry<T>[] = [];
    let tokensUsed = 0;
    let trimmedCount = 0;
    let droppedByTokenBudget = 0;

    for (const result of capped) {
      const selection = this.selectContent(result);
      const { content } = selection;
      const tokens = estimateMemoryTokens(content);

      if (tokensUsed + tokens > this.maxTokens) {
        const fallback = this.selectFallbackContent(result, selection);

        if (fallback) {
          const fallbackTokens = estimateMemoryTokens(fallback.content);
          if (tokensUsed + fallbackTokens <= this.maxTokens) {
            budgeted.push({
              result: withBudgetedContent(result, fallback.content),
              tokenEstimate: fallbackTokens,
              usedSummary: fallback.usedSummary,
            });
            tokensUsed += fallbackTokens;
            trimmedCount++;
            continue;
          }
        }
        droppedByTokenBudget = capped.length - budgeted.length;
        // Policy: stop here to preserve ranked order. Lower-ranked results are
        // not considered even if they might be smaller and fit the remaining budget.
        break;
      }

      budgeted.push({
        result: withBudgetedContent(result, content),
        tokenEstimate: tokens,
        usedSummary: selection.usedSummary,
      });
      tokensUsed += tokens;
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
      droppedByResultCap,
      droppedByTokenBudget,
    };
  }

  /**
   * Get the effective content string for a result based on verbosity
   * and summary-first settings.
   */
  getContent<T extends MemoryResult>(result: T): string {
    return this.selectContent(result).content;
  }

  // ─── Private ───────────────────────────────────────────────────────────

  private selectContent<T extends MemoryResult>(result: T): ContentSelection {
    if (this.verbosity === "detailed") {
      return { content: result.content, usedSummary: false };
    }

    if (this.verbosity === "minimal") {
      return result.summary
        ? { content: truncateForMinimal(result.summary), usedSummary: true }
        : { content: truncateForMinimal(result.content), usedSummary: false };
    }

    if (this.summaryFirst && result.summary) {
      return { content: result.summary, usedSummary: true };
    }

    return { content: result.content, usedSummary: false };
  }

  private selectFallbackContent<T extends MemoryResult>(
    result: T,
    selected: ContentSelection,
  ): ContentSelection | undefined {
    if (this.verbosity === "detailed") {
      return undefined;
    }

    if (result.summary && !selected.usedSummary) {
      return {
        content:
          this.verbosity === "minimal"
            ? truncateForMinimal(result.summary)
            : result.summary,
        usedSummary: true,
      };
    }

    if (selected.content !== result.content) {
      const content =
        this.verbosity === "minimal"
          ? truncateForMinimal(result.content)
          : result.content;
      if (content !== selected.content) {
        return { content, usedSummary: false };
      }
    }

    return undefined;
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

function normalizeVerbosity(value: BudgetVerbosity | undefined): BudgetVerbosity {
  return value === "minimal" || value === "standard" || value === "detailed"
    ? value
    : DEFAULT_VERBOSITY;
}

function truncateForMinimal(content: string): string {
  return content.length > MINIMAL_PER_RESULT_CHAR_CAP
    ? content.slice(0, MINIMAL_PER_RESULT_CHAR_CAP)
    : content;
}

function withBudgetedContent<T extends MemoryResult>(
  result: T,
  content: string,
): T {
  return content === result.content ? result : ({ ...result, content } as T);
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createContextBudgetManager(
  config?: ContextBudgetConfig,
): ContextBudgetManager {
  return new ContextBudgetManager(config);
}
