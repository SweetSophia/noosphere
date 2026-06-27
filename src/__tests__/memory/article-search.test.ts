import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildFallbackSearchTsQuery,
  extractFallbackSearchTerms,
} from "@/lib/memory/article-search";

describe("article search fallback terms", () => {
  it("keeps the durable concept from conversational photo phrasing", () => {
    const terms = extractFallbackSearchTerms(
      "Because it looks like you forgot the photo of you, I'll reattach it",
    );

    assert.ok(terms.includes("photo"));
    assert.ok(terms.includes("portrait"));
    assert.ok(!terms.includes("face"));
    assert.ok(!terms.includes("ill"));
  });

  it("keeps fallback terms bounded for long messages", () => {
    const terms = extractFallbackSearchTerms(
      "Please check whether this long message about markdown import access control search recall deployment " +
        "settings budget tokens providers and conflict handling needs every term",
    );

    assert.ok(terms.length <= 16);
  });

  it("drops common function words so fallback queries do not become broad", () => {
    assert.deepEqual(
      extractFallbackSearchTerms("the and of is are was were be been being has had do does did will may might can shall"),
      [],
    );
    assert.equal(buildFallbackSearchTsQuery("the and of"), null);
  });

  it("strips tsquery operators before building fallback terms", () => {
    assert.deepEqual(
      extractFallbackSearchTerms("foo & bar | baz !qux <-> quux"),
      ["foo", "bar", "baz", "qux", "quux"],
    );
  });
});
