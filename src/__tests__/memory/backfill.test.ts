/**
 * Tests for the backfill/synthesis pipeline.
 *
 * Covers: job creation, content merging, synthesis execution,
 * job lifecycle, retry logic, and filtering.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SYNTHESIS_CONFIG,
  slugify,
  generateJobId,
  createSynthesisJob,
  mergeContent,
  prepareSynthesisInput,
  synthesize,
  updateJobStatus,
  canRetry,
  retryJob,
  getPendingJobs,
  filterJobsByStatus,
  type SynthesisJob,
} from "@/lib/memory/backfill";
import type { PromotionCandidate } from "@/lib/memory/promotion";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCandidate(
  overrides: Partial<PromotionCandidate> = {},
): PromotionCandidate {
  return {
    memoryId: "mem-1",
    provider: "test",
    currentLevel: "ephemeral",
    targetLevel: "managed",
    recallCount: 5,
    avgRelevance: 0.7,
    status: "approved",
    createdAt: "2026-04-27T00:00:00Z",
    updatedAt: "2026-04-27T00:00:00Z",
    ...overrides,
  };
}

function makeJob(overrides: Partial<SynthesisJob> = {}): SynthesisJob {
  return {
    id: "syn_test",
    candidate: makeCandidate(),
    status: "pending",
    strategy: "append",
    createdAt: "2026-04-27T00:00:00Z",
    updatedAt: "2026-04-27T00:00:00Z",
    retryCount: 0,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("backfill", () => {
  // [1] slugify: basic
  test("[1] slugify converts title to URL-safe slug", () => {
    assert.equal(slugify("Hello World"), "hello-world");
  });

  // [2] slugify: special characters
  test("[2] slugify strips special characters", () => {
    assert.equal(
      slugify("React & Vue: A Comparison!"),
      "react-vue-a-comparison",
    );
  });

  // [3] slugify: collapses hyphens
  test("[3] slugify collapses multiple hyphens", () => {
    assert.equal(slugify("foo---bar"), "foo-bar");
  });

  // [4] slugify: trims to 100 chars
  test("[4] slugify trims long titles to 100 characters", () => {
    const long = "a".repeat(150);
    assert.equal(slugify(long).length, 100);
  });

  // [5] slugify: empty string
  test("[5] slugify handles empty string", () => {
    assert.equal(slugify(""), "untitled");
  });

  // [5b] slugify: special chars only falls back
  test("[5b] slugify falls back when text sanitizes to empty", () => {
    assert.equal(slugify("!!!@@@###"), "untitled");
  });

  // [6] generateJobId: deterministic
  test("[6] generateJobId produces consistent IDs for same input", () => {
    const candidate = makeCandidate();
    const id1 = generateJobId(candidate, "2026-04-27T00:00:00Z");
    const id2 = generateJobId(candidate, "2026-04-27T00:00:00Z");
    assert.equal(id1, id2);
  });

  // [7] generateJobId: starts with syn_
  test("[7] generateJobId starts with syn_", () => {
    const candidate = makeCandidate();
    const id = generateJobId(candidate);
    assert.ok(id.startsWith("syn_"));
  });

  // [8] createSynthesisJob
  test("[8] creates job with correct defaults", () => {
    const candidate = makeCandidate();
    const job = createSynthesisJob(candidate, "append", "2026-04-27T00:00:00Z");
    assert.equal(job.candidate.memoryId, "mem-1");
    assert.equal(job.status, "pending");
    assert.equal(job.strategy, "append");
    assert.equal(job.retryCount, 0);
  });

  // [9] mergeContent: append
  test("[9] merge with append strategy", () => {
    const result = mergeContent("existing", "new", "append");
    assert.equal(result, "existing\n\n---\n\nnew");
  });

  // [10] mergeContent: replace
  test("[10] merge with replace strategy", () => {
    const result = mergeContent("existing", "new", "replace");
    assert.equal(result, "new");
  });

  // [11] mergeContent: merge
  test("[11] merge with merge strategy", () => {
    const result = mergeContent("existing", "new", "merge");
    assert.ok(result.includes("existing"));
    assert.ok(result.includes("new"));
    assert.ok(result.includes("Updated Content"));
  });

  // [12] prepareSynthesisInput
  test("[12] prepareSynthesisInput uses defaults from config", () => {
    const candidate = makeCandidate();
    const input = prepareSynthesisInput(candidate, "content", "Title");
    assert.equal(input.content, "content");
    assert.equal(input.title, "Title");
    assert.equal(input.topicSlug, DEFAULT_SYNTHESIS_CONFIG.defaultTopicSlug);
    assert.equal(input.existingArticleId, undefined);
  });

  // [13] prepareSynthesisInput with existing article
  test("[13] prepareSynthesisInput passes existing article data", () => {
    const candidate = makeCandidate();
    const input = prepareSynthesisInput(
      candidate,
      "new content",
      "Title",
      "Summary",
      "art-1",
      "old content",
    );
    assert.equal(input.existingArticleId, "art-1");
    assert.equal(input.existingContent, "old content");
  });

  // [14] synthesize: create new article
  test("[14] synthesize creates new article", () => {
    const input = {
      content: "New article content",
      title: "My Article",
      topicSlug: "test",
    };
    const result = synthesize(input);
    assert.equal(result.success, true);
    assert.equal(result.created, true);
    assert.equal(result.articleSlug, "my-article");
    assert.equal(result.content, "New article content");
  });

  // [15] synthesize: update existing article
  test("[15] synthesize updates existing article", () => {
    const input = {
      content: "Updated content",
      topicSlug: "test",
      existingArticleId: "art-1",
      existingContent: "Old content",
    };
    const result = synthesize(input, "append");
    assert.equal(result.success, true);
    assert.equal(result.created, false);
    assert.equal(result.articleId, "art-1");
    assert.ok(result.content!.includes("Updated content"));
    assert.ok(result.content!.includes("Old content"));
  });

  // [16] synthesize: default title when none provided
  test("[16] synthesize uses default title when missing", () => {
    const input = { content: "content", topicSlug: "test" };
    const result = synthesize(input);
    assert.equal(result.articleSlug, "synthesized-memory");
  });

  // [16b] synthesize: existing ID without content fails for merge strategies
  test("[16b] synthesize fails when merge/update content is missing", () => {
    const input = {
      content: "content",
      topicSlug: "test",
      existingArticleId: "art-1",
    };
    const result = synthesize(input, "append");
    assert.equal(result.success, false);
    assert.equal(result.created, false);
    assert.match(result.error!, /content missing/i);
  });

  // [16c] synthesize: replace strategy allows missing existing content
  test("[16c] synthesize allows replace update without existing content", () => {
    const input = {
      content: "replacement",
      topicSlug: "test",
      existingArticleId: "art-1",
    };
    const result = synthesize(input, "replace");
    assert.equal(result.success, true);
    assert.equal(result.created, false);
    assert.equal(result.articleId, "art-1");
    assert.equal(result.content, "replacement");
  });

  // [17] updateJobStatus: completed
  test("[17] updateJobStatus marks completed with result", () => {
    const job = makeJob();
    const updated = updateJobStatus(
      job,
      "completed",
      {
        success: true,
        articleId: "art-1",
        created: true,
      },
      "2026-04-27T12:00:00Z",
    );
    assert.equal(updated.status, "completed");
    assert.equal(updated.completedAt, "2026-04-27T12:00:00Z");
    assert.equal(updated.articleId, "art-1");
  });

  // [18] updateJobStatus: failed
  test("[18] updateJobStatus marks failed with error", () => {
    const job = makeJob();
    const updated = updateJobStatus(
      job,
      "failed",
      {
        success: false,
        created: false,
        error: "DB write failed",
      },
      "2026-04-27T12:00:00Z",
    );
    assert.equal(updated.status, "failed");
    assert.equal(updated.error, "DB write failed");
    assert.equal(updated.completedAt, "2026-04-27T12:00:00Z");
  });

  // [19] canRetry: under limit
  test("[19] canRetry allows retry when under max", () => {
    const job = makeJob({ status: "failed", retryCount: 1 });
    assert.equal(canRetry(job, 3), true);
  });

  // [20] canRetry: at limit
  test("[20] canRetry denies retry at max", () => {
    const job = makeJob({ status: "failed", retryCount: 3 });
    assert.equal(canRetry(job, 3), false);
  });

  // [21] canRetry: non-failed job
  test("[21] canRetry denies retry for non-failed job", () => {
    const job = makeJob({ status: "pending", retryCount: 0 });
    assert.equal(canRetry(job, 3), false);
  });

  // [22] retryJob
  test("[22] retryJob increments count and resets status", () => {
    const job = makeJob({
      status: "failed",
      retryCount: 1,
      error: "oops",
      completedAt: "2026-04-27T11:00:00Z",
    });
    const retried = retryJob(job, "2026-04-27T12:00:00Z");
    assert.equal(retried.status, "pending");
    assert.equal(retried.retryCount, 2);
    assert.equal(retried.error, undefined);
    assert.equal(retried.completedAt, undefined);
    assert.equal(retried.updatedAt, "2026-04-27T12:00:00Z");
  });

  // [23] getPendingJobs
  test("[23] getPendingJobs returns only pending jobs with approved candidates", () => {
    const jobs = [
      makeJob({ status: "pending" }), // candidate is approved by default
      makeJob({
        id: "syn_2",
        status: "pending",
        candidate: makeCandidate({ status: "pending" }),
      }),
      makeJob({ id: "syn_3", status: "completed" }),
    ];
    const pending = getPendingJobs(jobs);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, "syn_test");
  });

  // [24] filterJobsByStatus
  test("[24] filterJobsByStatus filters correctly", () => {
    const jobs = [
      makeJob({ status: "pending" }),
      makeJob({ id: "syn_2", status: "completed" }),
      makeJob({ id: "syn_3", status: "failed" }),
    ];
    assert.equal(filterJobsByStatus(jobs, "pending").length, 1);
    assert.equal(filterJobsByStatus(jobs, "completed").length, 1);
    assert.equal(filterJobsByStatus(jobs, "failed").length, 1);
  });

  // [25] synthesize: replace strategy on update
  test("[25] synthesize replace strategy replaces existing content", () => {
    const input = {
      content: "Brand new content",
      topicSlug: "test",
      existingArticleId: "art-1",
      existingContent: "Old content that should be replaced",
    };
    const result = synthesize(input, "replace");
    assert.equal(result.content, "Brand new content");
    assert.ok(!result.content!.includes("Old"));
  });

  // [27] retryJob clears completedAt
  test("[27] retryJob clears completedAt from previous attempt", () => {
    const job = makeJob({
      status: "failed",
      retryCount: 1,
      completedAt: "2026-04-27T12:00:00Z",
      error: "DB error",
    });
    const retried = retryJob(job, "2026-04-27T13:00:00Z");
    assert.equal(retried.completedAt, undefined);
    assert.equal(retried.status, "pending");
  });

  // [28] slugify: special-char-only input gets fallback
  test("[28] slugify returns untitled for special-char-only input", () => {
    assert.equal(slugify("@@@!!!###"), "untitled");
  });

  // [29] retryJob throws on non-failed job
  test("[29] retryJob throws when job is not failed", () => {
    const job = makeJob({ status: "completed" });
    let threw = false;
    try {
      retryJob(job, "2026-04-27T14:00:00Z");
    } catch {
      threw = true;
    }
    assert.ok(threw, "Expected retryJob to throw on completed job");
  });
});
