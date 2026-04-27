/**
 * Backfill and synthesis pipeline for promoted memories.
 *
 * Takes approved promotion candidates and creates or updates Noosphere
 * articles from the underlying memory content. This is the bridge between
 * the recall/recording layer (ephemeral memories) and the knowledge layer
 * (structured Noosphere articles).
 *
 * ## Synthesis Flow
 *
 * 1. Pick up approved promotion candidates
 * 2. For each candidate, fetch the source memory content
 * 3. If a matching article exists → update it with new information
 * 4. If no match → create a new draft article
 * 5. Mark the candidate as "synthesized"
 *
 * ## Content Resolution
 *
 * When updating an existing article, the synthesizer uses a configurable
 * strategy to merge content:
 * - "append": Add new content as a section at the end
 * - "replace": Replace the article content entirely
 * - "merge": Intelligent merge (future — placeholder for now)
 *
 * @module backfill
 */

import type { PromotionCandidate } from "./promotion";
import type { MemoryCurationLevel } from "./types";

// ─── Types ──────────────────────────────────────────────────────────────────

export type SynthesisStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed";

export type ContentStrategy = "append" | "replace" | "merge";

export interface SynthesisJob {
  /** Unique job identifier. */
  id: string;

  /** The promotion candidate being synthesized. */
  candidate: PromotionCandidate;

  /** Current job status. */
  status: SynthesisStatus;

  /** Content merge strategy. */
  strategy: ContentStrategy;

  /** ISO-8601 timestamp when the job was created. */
  createdAt: string;

  /** ISO-8601 timestamp when the job was last updated. */
  updatedAt: string;

  /** ISO-8601 timestamp when the job completed (if completed). */
  completedAt?: string;

  /** Result article ID (if created/updated). */
  articleId?: string;

  /** Result article slug (if created/updated). */
  articleSlug?: string;

  /** Error message if the job failed. */
  error?: string;

  /** Number of retry attempts. */
  retryCount: number;
}

export interface SynthesisInput {
  /** The memory content to synthesize into an article. */
  content: string;

  /** Optional title for the new/updated article. */
  title?: string;

  /** Optional summary/excerpt. */
  summary?: string;

  /** Optional tags to apply. */
  tags?: string[];

  /** Topic slug to assign the article to. */
  topicSlug: string;

  /** Existing article ID to update (if any). */
  existingArticleId?: string;

  /** Existing article content (for merge strategies). */
  existingContent?: string;
}

export interface SynthesisResult {
  /** Whether the synthesis was successful. */
  success: boolean;

  /** ID of the created or updated article. */
  articleId?: string;

  /** Slug of the created or updated article. */
  articleSlug?: string;

  /** The final article content after synthesis. */
  content?: string;

  /** Whether a new article was created (vs updating existing). */
  created: boolean;

  /** Error message if synthesis failed. */
  error?: string;
}

export interface SynthesisConfig {
  /** Default content merge strategy. */
  defaultStrategy: ContentStrategy;

  /** Topic slug for articles created by synthesis. */
  defaultTopicSlug: string;

  /** Maximum retry attempts for failed jobs. */
  maxRetries: number;

  /** Maximum concurrent synthesis jobs. */
  maxConcurrency: number;

  /** Whether to create articles as drafts or published. */
  createAsDraft: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

export const DEFAULT_SYNTHESIS_CONFIG: SynthesisConfig = {
  defaultStrategy: "append",
  defaultTopicSlug: "synthesis",
  maxRetries: 3,
  maxConcurrency: 5,
  createAsDraft: true,
};

// ─── Functions ──────────────────────────────────────────────────────────────

/**
 * Generate a slug from a title string.
 * Lowercases, replaces non-alphanumeric with hyphens, collapses duplicates.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100) || "untitled";
}

/**
 * Generate a unique job ID for a synthesis job.
 */
export function generateJobId(
  candidate: PromotionCandidate,
  timestamp: string = new Date().toISOString(),
): string {
  const hash = `${candidate.provider}-${candidate.memoryId}-${timestamp}`;
  // Simple deterministic suffix
  let h = 0;
  for (let i = 0; i < hash.length; i++) {
    h = ((h << 5) - h + hash.charCodeAt(i)) | 0;
  }
  return `syn_${Math.abs(h).toString(36)}`;
}

/**
 * Create a new synthesis job from a promotion candidate.
 */
export function createSynthesisJob(
  candidate: PromotionCandidate,
  strategy: ContentStrategy = DEFAULT_SYNTHESIS_CONFIG.defaultStrategy,
  now: string = new Date().toISOString(),
): SynthesisJob {
  return {
    id: generateJobId(candidate, now),
    candidate,
    status: "pending",
    strategy,
    createdAt: now,
    updatedAt: now,
    retryCount: 0,
  };
}

/**
 * Merge content using the specified strategy.
 */
export function mergeContent(
  existing: string,
  incoming: string,
  strategy: ContentStrategy,
): string {
  switch (strategy) {
    case "append":
      return `${existing}\n\n---\n\n${incoming}`;
    case "replace":
      return incoming;
    case "merge":
      // Placeholder: for now, same as append with a different separator
      return `${existing}\n\n## Updated Content\n\n${incoming}`;
    default:
      return incoming;
  }
}

/**
 * Prepare synthesis input from a promotion candidate and source memory.
 */
export function prepareSynthesisInput(
  candidate: PromotionCandidate,
  memoryContent: string,
  memoryTitle?: string,
  memorySummary?: string,
  existingArticleId?: string,
  existingContent?: string,
  config: SynthesisConfig = DEFAULT_SYNTHESIS_CONFIG,
): SynthesisInput {
  return {
    content: memoryContent,
    title: memoryTitle,
    summary: memorySummary,
    topicSlug: config.defaultTopicSlug,
    existingArticleId,
    existingContent,
  };
}

/**
 * Execute a synthesis step — produces the final content for an article.
 * This is a pure function that resolves the content; actual DB writes
 * happen in the wiring layer.
 */
export function synthesize(
  input: SynthesisInput,
  strategy: ContentStrategy = DEFAULT_SYNTHESIS_CONFIG.defaultStrategy,
): SynthesisResult {
  try {
    // If updating an existing article, merge or replace content.
    if (input.existingArticleId) {
      // When existingContent is available, apply the merge strategy.
      // When missing (e.g. replace strategy or unavailable content),
      // just use the incoming content directly.
      const resolvedContent = input.existingContent
        ? mergeContent(input.existingContent, input.content, strategy)
        : input.content;

      return {
        success: true,
        articleId: input.existingArticleId,
        content: resolvedContent,
        created: false,
      };
    }

    // Creating a new article
    const title = input.title || "Synthesized Memory";
    const slug = slugify(title);

    return {
      success: true,
      articleSlug: slug,
      content: input.content,
      created: true,
    };
  } catch (err) {
    return {
      success: false,
      created: false,
      error: err instanceof Error ? err.message : "Unknown synthesis error",
    };
  }
}

/**
 * Update a synthesis job's status.
 */
export function updateJobStatus(
  job: SynthesisJob,
  status: SynthesisStatus,
  result?: SynthesisResult,
  now: string = new Date().toISOString(),
): SynthesisJob {
  return {
    ...job,
    status,
    updatedAt: now,
    completedAt: status === "completed" || status === "failed" ? now : undefined,
    articleId: result?.articleId ?? job.articleId,
    articleSlug: result?.articleSlug ?? job.articleSlug,
    error: status === "failed" ? result?.error ?? job.error : undefined,
  };
}

/**
 * Check if a failed job can be retried.
 */
export function canRetry(
  job: SynthesisJob,
  maxRetries: number = DEFAULT_SYNTHESIS_CONFIG.maxRetries,
): boolean {
  return (
    job.status === "failed" && job.retryCount < maxRetries
  );
}

/**
 * Increment the retry count and reset status to pending.
 */
export function retryJob(
  job: SynthesisJob,
  now: string = new Date().toISOString(),
): SynthesisJob {
  return {
    ...job,
    status: "pending",
    retryCount: job.retryCount + 1,
    updatedAt: now,
    completedAt: undefined,
    error: undefined,
  };
}

/**
 * Filter approved candidates that are ready for synthesis.
 */
export function getPendingJobs(
  jobs: SynthesisJob[],
): SynthesisJob[] {
  return jobs.filter(
    (j) => j.status === "pending" && j.candidate.status === "approved",
  );
}

/**
 * Filter jobs by status.
 */
export function filterJobsByStatus(
  jobs: SynthesisJob[],
  status: SynthesisStatus,
): SynthesisJob[] {
  return jobs.filter((j) => j.status === status);
}
