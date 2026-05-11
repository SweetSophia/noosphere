import assert from "node:assert/strict";
import test from "node:test";
import {
  ARTICLE_LIMITS,
  deriveExcerpt,
  isValidConfidence,
  isValidStatus,
  sanitizeAuthorName,
  validateSlug,
} from "@/lib/validation";

test("deriveExcerpt strips markdown and truncates", () => {
  assert.equal(deriveExcerpt("# Hello\n\n**world**"), "Hello world");
  assert.equal(deriveExcerpt("`code` and _italic_"), "code and italic");
  assert.equal(deriveExcerpt("a".repeat(200), 10), "aaaaaaaaaa");
});

test("validateSlug accepts valid slugs", () => {
  const result = validateSlug("hello-world");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.slug, "hello-world");
});

test("validateSlug rejects empty slugs", () => {
  const result = validateSlug("");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "Slug is required");
});

test("validateSlug rejects invalid characters", () => {
  const result = validateSlug("hello_world");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "Slug must be lowercase alphanumeric with hyphens only");
});

test("isValidStatus accepts known statuses", () => {
  assert.equal(isValidStatus("draft"), true);
  assert.equal(isValidStatus("reviewed"), true);
  assert.equal(isValidStatus("published"), true);
  assert.equal(isValidStatus("archived"), false);
});

test("isValidConfidence accepts known values", () => {
  assert.equal(isValidConfidence("low"), true);
  assert.equal(isValidConfidence("medium"), true);
  assert.equal(isValidConfidence("high"), true);
  assert.equal(isValidConfidence("critical"), false);
});

test("sanitizeAuthorName strips HTML and caps length", () => {
  assert.equal(sanitizeAuthorName("<script>alert(1)</script>"), "alert(1)");
  assert.equal(sanitizeAuthorName("  Normal Name  "), "Normal Name");
  assert.equal(sanitizeAuthorName("a".repeat(200), 10), "a".repeat(10));
  assert.equal(sanitizeAuthorName(undefined), "");
});

test("ARTICLE_LIMITS are sensible", () => {
  assert.equal(ARTICLE_LIMITS.maxContentSize, 1024 * 1024);
  assert.equal(ARTICLE_LIMITS.maxTitleLength, 200);
  assert.equal(ARTICLE_LIMITS.maxExcerptLength, 500);
});
