import assert from "node:assert/strict";
import test from "node:test";

import { sameRestrictedTags } from "@/app/api/import/route";

// Pure-function tests pinning the C4 contract: `sameRestrictedTags` is
// order-insensitive AND duplicate-tolerant. The pre-C4 implementation
// returned `true` for `[a, a]` vs `[a, b]` because both entries of the
// first set were `has(tag)` on the second; the fix compares set sizes.

test("sameRestrictedTags returns true for identical sets", () => {
  assert.equal(sameRestrictedTags(["a", "b"], ["a", "b"]), true);
});

test("sameRestrictedTags is order-insensitive", () => {
  assert.equal(sameRestrictedTags(["a", "b"], ["b", "a"]), true);
});

test("sameRestrictedTags rejects different sets of the same length", () => {
  assert.equal(sameRestrictedTags(["a", "b"], ["a", "c"]), false);
  assert.equal(sameRestrictedTags(["a", "b"], ["c", "d"]), false);
});

test("sameRestrictedTags rejects sets of different sizes", () => {
  assert.equal(sameRestrictedTags(["a"], ["a", "b"]), false);
  assert.equal(sameRestrictedTags(["a", "b"], ["a"]), false);
});

test("sameRestrictedTags is duplicate-tolerant (regression: C4)", () => {
  // `[a, a]` and `[a]` represent the same logical set, so this is equal.
  // The pre-C4 implementation rejected this case because `a.length === 2`
  // and `b.length === 1` failed the length check.
  assert.equal(sameRestrictedTags(["a", "a"], ["a"]), true);
  assert.equal(sameRestrictedTags(["a"], ["a", "a"]), true);
});

test("sameRestrictedTags still rejects duplicates that mask a real diff", () => {
  // `[a, a]` and `[a, b]` are NOT the same set: deduping the first gives
  // `{a}`; the second is `{a, b}`. The pre-C4 implementation would have
  // returned `true` here because both `a` entries of the first set have a
  // matching tag in the second. The C4 fix makes the comparison set-based.
  assert.equal(sameRestrictedTags(["a", "a"], ["a", "b"]), false);
});

test("sameRestrictedTags handles empty arrays symmetrically", () => {
  assert.equal(sameRestrictedTags([], []), true);
  assert.equal(sameRestrictedTags(["a"], []), false);
  assert.equal(sameRestrictedTags([], ["a"]), false);
});
