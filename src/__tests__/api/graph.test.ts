import assert from "node:assert/strict";
import test from "node:test";
import {
  buildArticleLookupMaps,
  GRAPH_CONTENT_MAX_BYTES_DEFAULT,
  GRAPH_CONTENT_MAX_BYTES_MAX,
  isContentWithinByteLimit,
  parseGraphQueryParams,
} from "@/lib/graph";

test.describe("parseGraphQueryParams", () => {
  test("uses safe defaults", () => {
    assert.deepEqual(parseGraphQueryParams(new URLSearchParams()), {
      limit: 100,
      contentLimit: 100,
      contentMaxBytes: GRAPH_CONTENT_MAX_BYTES_DEFAULT,
    });
  });

  test("preserves explicit zero values for content parsing controls", () => {
    const params = new URLSearchParams({
      contentLimit: "0",
      contentMaxBytes: "0",
    });

    assert.deepEqual(parseGraphQueryParams(params), {
      limit: 100,
      contentLimit: 0,
      contentMaxBytes: 0,
    });
  });

  test("clamps client-provided limits to server-side ceilings", () => {
    const params = new URLSearchParams({
      limit: "999",
      contentLimit: "999",
      contentMaxBytes: "999999999",
    });

    assert.deepEqual(parseGraphQueryParams(params), {
      limit: 500,
      contentLimit: 500,
      contentMaxBytes: GRAPH_CONTENT_MAX_BYTES_MAX,
    });
  });

  test("falls back only for invalid numeric values", () => {
    const params = new URLSearchParams({
      limit: "not-a-number",
      contentLimit: "also-bad",
      contentMaxBytes: "bad",
    });

    assert.deepEqual(parseGraphQueryParams(params), {
      limit: 100,
      contentLimit: 100,
      contentMaxBytes: GRAPH_CONTENT_MAX_BYTES_DEFAULT,
    });
  });
});

test.describe("isContentWithinByteLimit", () => {
  test("rejects zero-byte limits", () => {
    assert.equal(isContentWithinByteLimit("", 0), false);
    assert.equal(isContentWithinByteLimit("a", 0), false);
  });

  test("uses a cheap character-length rejection before byte measurement", () => {
    assert.equal(isContentWithinByteLimit("a".repeat(11), 10), false);
  });

  test("checks UTF-8 byte length for short content", () => {
    assert.equal(isContentWithinByteLimit("\u00e9", 1), false);
    assert.equal(isContentWithinByteLimit("\u00e9", 2), true);
  });
});

test("buildArticleLookupMaps creates slug and topic-scoped lookup maps", () => {
  const first = { slug: "shared", topic: { slug: "alpha" }, id: "first" };
  const second = { slug: "shared", topic: { slug: "beta" }, id: "second" };
  const { articleBySlug, articleByTopicSlug } = buildArticleLookupMaps([
    first,
    second,
  ]);

  assert.equal(articleBySlug.get("shared"), first);
  assert.equal(articleByTopicSlug.get("alpha:shared"), first);
  assert.equal(articleByTopicSlug.get("beta:shared"), second);
});
