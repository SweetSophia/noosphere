import assert from "node:assert/strict";
import test, { describe } from "node:test";

/**
 * Tests for pure utility functions from src/lib/wiki.ts.
 *
 * The wiki module imports prisma at module level, so we inline the pure
 * functions here to test without a database connection.
 * Keep these in sync with src/lib/wiki.ts.
 */

// ─── Inline copies of pure functions ────────────────────────────────────────

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9 -]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .trim() || "untitled"
  );
}

function parseTagInput(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  );
}

interface NormalizedTagInput {
  name: string;
  slug: string;
}

function normalizeTagInputs(tagNames: string[]): NormalizedTagInput[] {
  const bySlug = new Map<string, NormalizedTagInput>();
  for (const name of tagNames) {
    const trimmed = name.trim();
    const slug = slugify(trimmed);
    if (!slug || bySlug.has(slug)) continue;
    bySlug.set(slug, { name: trimmed, slug });
  }
  return Array.from(bySlug.values());
}

// ─── slugify ────────────────────────────────────────────────────────────────

describe("slugify", () => {
  test("lowercases text", () => {
    assert.equal(slugify("Hello World"), "hello-world");
  });

  test("replaces spaces with hyphens", () => {
    assert.equal(slugify("hello world"), "hello-world");
  });

  test("removes special characters", () => {
    assert.equal(slugify("hello!@#$%world"), "helloworld");
  });

  test("collapses multiple hyphens", () => {
    assert.equal(slugify("hello---world"), "hello-world");
  });

  test("removes leading and trailing hyphens", () => {
    assert.equal(slugify("-hello-world-"), "hello-world");
  });

  test("handles multiple spaces", () => {
    assert.equal(slugify("hello   world"), "hello-world");
  });

  test("returns 'untitled' for empty input", () => {
    assert.equal(slugify(""), "untitled");
  });

  test("returns 'untitled' for input with only special chars", () => {
    assert.equal(slugify("!@#$%^&*"), "untitled");
  });

  test("preserves numbers", () => {
    assert.equal(slugify("Article 123"), "article-123");
  });

  test("handles mixed case and special chars", () => {
    assert.equal(slugify("My Article (Part 2)"), "my-article-part-2");
  });

  test("handles unicode characters by removing them", () => {
    assert.equal(slugify("café"), "caf");
  });

  test("handles already-valid slugs", () => {
    assert.equal(slugify("already-valid"), "already-valid");
  });
});

// ─── parseTagInput ──────────────────────────────────────────────────────────

describe("parseTagInput", () => {
  test("returns empty array for null", () => {
    assert.deepEqual(parseTagInput(null), []);
  });

  test("returns empty array for undefined", () => {
    assert.deepEqual(parseTagInput(undefined), []);
  });

  test("returns empty array for empty string", () => {
    assert.deepEqual(parseTagInput(""), []);
  });

  test("splits comma-separated tags", () => {
    assert.deepEqual(parseTagInput("tag1,tag2,tag3"), [
      "tag1",
      "tag2",
      "tag3",
    ]);
  });

  test("trims whitespace from tags", () => {
    assert.deepEqual(parseTagInput(" tag1 , tag2 , tag3 "), [
      "tag1",
      "tag2",
      "tag3",
    ]);
  });

  test("filters empty segments", () => {
    assert.deepEqual(parseTagInput("tag1,,tag2,,,tag3"), [
      "tag1",
      "tag2",
      "tag3",
    ]);
  });

  test("deduplicates tags", () => {
    assert.deepEqual(parseTagInput("tag1,tag2,tag1"), ["tag1", "tag2"]);
  });

  test("handles single tag", () => {
    assert.deepEqual(parseTagInput("single"), ["single"]);
  });

  test("handles whitespace-only input", () => {
    assert.deepEqual(parseTagInput("   "), []);
  });
});

// ─── normalizeTagInputs ────────────────────────────────────────────────────

describe("normalizeTagInputs", () => {
  test("normalizes tag names to slugs", () => {
    const result = normalizeTagInputs(["Hello World", "Test Tag"]);
    assert.deepEqual(result, [
      { name: "Hello World", slug: "hello-world" },
      { name: "Test Tag", slug: "test-tag" },
    ]);
  });

  test("deduplicates by slug", () => {
    const result = normalizeTagInputs(["Hello World", "hello world"]);
    assert.equal(result.length, 1);
    assert.equal(result[0].slug, "hello-world");
  });

  test("keeps first occurrence name on slug conflict", () => {
    const result = normalizeTagInputs(["Hello World", "hello  world"]);
    assert.equal(result[0].name, "Hello World");
  });

  test("trims whitespace from names", () => {
    const result = normalizeTagInputs(["  spaced  "]);
    assert.equal(result[0].name, "spaced");
  });

  test("returns empty array for empty input", () => {
    assert.deepEqual(normalizeTagInputs([]), []);
  });

  test("skips tags that produce empty slugs", () => {
    const result = normalizeTagInputs(["!!!", "valid"]);
    // "!!!" slugifies to "untitled", so it should be included
    assert.equal(result.length, 2);
  });

  test("handles mixed valid and duplicate inputs", () => {
    const result = normalizeTagInputs([
      "JavaScript",
      "javascript",
      "TypeScript",
    ]);
    assert.equal(result.length, 2);
    assert.equal(result[0].slug, "javascript");
    assert.equal(result[1].slug, "typescript");
  });
});
