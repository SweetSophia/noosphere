import assert from "node:assert/strict";
import test from "node:test";
import {
  LINT_MAX_ARTICLES_DEFAULT,
  LINT_MAX_ARTICLES_HARD_LIMIT,
  LINT_STALE_DAYS_MAX,
  LINT_STALE_DAYS_MIN,
  LINT_TAG_MIN_MAX,
  LINT_TAG_MIN_MIN,
  parseLintOptions,
} from "@/lib/lint-options";

function parseMaxArticles(value: unknown): number {
  const result = parseLintOptions({ maxArticles: value });
  assert.equal(result.ok, true);
  if (!result.ok) return 0;
  return result.options.maxArticles;
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

test.describe("staleDays and tagMin parsing logic", () => {
  test("uses defaults when values are undefined", () => {
    const result = parseLintOptions({});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.options.staleDays, 90);
    assert.equal(result.options.tagMin, 2);
  });

  test("floors decimals before clamping", () => {
    const result = parseLintOptions({ staleDays: 10.9, tagMin: 4.8 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.options.staleDays, 10);
    assert.equal(result.options.tagMin, 4);
  });

  test("clamps staleDays and tagMin to safe ranges", () => {
    const low = parseLintOptions({ staleDays: -10, tagMin: 0 });
    assert.equal(low.ok, true);
    if (!low.ok) return;
    assert.equal(low.options.staleDays, LINT_STALE_DAYS_MIN);
    assert.equal(low.options.tagMin, LINT_TAG_MIN_MIN);

    const high = parseLintOptions({ staleDays: 99999, tagMin: 999 });
    assert.equal(high.ok, true);
    if (!high.ok) return;
    assert.equal(high.options.staleDays, LINT_STALE_DAYS_MAX);
    assert.equal(high.options.tagMin, LINT_TAG_MIN_MAX);
  });

  test("rejects non-number staleDays and tagMin", () => {
    const staleDays = parseLintOptions({ staleDays: "90" });
    assert.equal(staleDays.ok, false);
    if (staleDays.ok) return;
    assert.equal(staleDays.error, "staleDays must be a finite number");

    const tagMin = parseLintOptions({ tagMin: "2" });
    assert.equal(tagMin.ok, false);
    if (tagMin.ok) return;
    assert.equal(tagMin.error, "tagMin must be a finite number");
  });

  test("rejects NaN and non-finite staleDays and tagMin", () => {
    const staleDays = parseLintOptions({ staleDays: Number.NaN });
    assert.equal(staleDays.ok, false);
    if (staleDays.ok) return;
    assert.equal(staleDays.error, "staleDays must be a finite number");

    const tagMin = parseLintOptions({ tagMin: Infinity });
    assert.equal(tagMin.ok, false);
    if (tagMin.ok) return;
    assert.equal(tagMin.error, "tagMin must be a finite number");
  });
});
