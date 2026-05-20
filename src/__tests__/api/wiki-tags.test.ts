import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeTagInputs, parseTagInput } from "@/lib/wiki";

describe("wiki tag helpers", () => {
  it("deduplicates normalized tag inputs by slug", () => {
    assert.deepEqual(normalizeTagInputs(["Tag", "tag", "AI ", "ai"]), [
      { name: "Tag", slug: "tag" },
      { name: "AI", slug: "ai" },
    ]);
  });

  it("falls back and deduplicates inputs that cannot produce a slug", () => {
    assert.deepEqual(normalizeTagInputs(["!!!", "機械", "Valid"]), [
      { name: "!!!", slug: "untitled" },
      { name: "Valid", slug: "valid" },
    ]);
  });

  it("deduplicates parsed comma input before database work", () => {
    assert.deepEqual(parseTagInput(" alpha, beta, alpha, , beta "), ["alpha", "beta"]);
  });
});
