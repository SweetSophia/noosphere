import assert from "node:assert/strict";
import test from "node:test";

// Test the same parsing logic used in the lint route
// Constants must match src/app/api/lint/route.ts
const LINT_MAX_ARTICLES_DEFAULT = 500;
const LINT_MAX_ARTICLES_HARD_LIMIT = 2000;

function parseMaxArticles(value: unknown): number {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    return LINT_MAX_ARTICLES_DEFAULT;
  }
  return Math.min(Math.max(1, parsed), LINT_MAX_ARTICLES_HARD_LIMIT);
}

test.describe("maxArticles parsing logic", () => {
  test("uses default when undefined", () => {
    assert.equal(parseMaxArticles(undefined), 500);
  });

  test("uses default when NaN", () => {
    assert.equal(parseMaxArticles(NaN), 500);
  });

  test("uses default when string 'invalid'", () => {
    assert.equal(parseMaxArticles("invalid"), 500);
  });

  test("uses default when object", () => {
    assert.equal(parseMaxArticles({}), 500);
  });

  test("clamps null to 1 (Number(null) === 0)", () => {
    // Number(null) === 0, which gets clamped to 1
    assert.equal(parseMaxArticles(null), 1);
  });

  test("accepts valid number within range", () => {
    assert.equal(parseMaxArticles(100), 100);
    assert.equal(parseMaxArticles(500), 500);
    assert.equal(parseMaxArticles(2000), 2000);
  });

  test("accepts string number", () => {
    assert.equal(parseMaxArticles("100"), 100);
    assert.equal(parseMaxArticles("500"), 500);
  });

  test("clamps negative to 1", () => {
    assert.equal(parseMaxArticles(-1), 1);
    assert.equal(parseMaxArticles(-100), 1);
  });

  test("clamps zero to 1", () => {
    assert.equal(parseMaxArticles(0), 1);
  });

  test("clamps above hard limit to 2000", () => {
    assert.equal(parseMaxArticles(99999), 2000);
    assert.equal(parseMaxArticles(5000), 2000);
  });

  test("accepts boundary values", () => {
    assert.equal(parseMaxArticles(1), 1);
    assert.equal(parseMaxArticles(2000), 2000);
  });

  test("handles decimal numbers", () => {
    // Number() preserves decimals; Math.min/max don't truncate
    // So 10.7 stays 10.7 (not clamped by min/max since it's between 1 and 2000)
    assert.equal(parseMaxArticles(10.7), 10.7);
    assert.equal(parseMaxArticles(10.3), 10.3);
    // But decimals above hard limit get clamped
    assert.equal(parseMaxArticles(3000.5), 2000);
  });

  test("handles boolean values", () => {
    // Number(true) === 1, Number(false) === 0
    assert.equal(parseMaxArticles(true), 1);
    assert.equal(parseMaxArticles(false), 1); // 0 clamped to 1
  });
});

test.describe("LINT_MAX_ARTICLES constants", () => {
  test("DEFAULT is 500", () => {
    assert.equal(LINT_MAX_ARTICLES_DEFAULT, 500);
  });

  test("HARD_LIMIT is 2000", () => {
    assert.equal(LINT_MAX_ARTICLES_HARD_LIMIT, 2000);
  });

  test("HARD_LIMIT is greater than DEFAULT", () => {
    assert.ok(LINT_MAX_ARTICLES_HARD_LIMIT > LINT_MAX_ARTICLES_DEFAULT);
  });

  test("values are positive integers", () => {
    assert.ok(Number.isInteger(LINT_MAX_ARTICLES_DEFAULT));
    assert.ok(Number.isInteger(LINT_MAX_ARTICLES_HARD_LIMIT));
    assert.ok(LINT_MAX_ARTICLES_DEFAULT > 0);
    assert.ok(LINT_MAX_ARTICLES_HARD_LIMIT > 0);
  });
});
