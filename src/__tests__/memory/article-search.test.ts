import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildFallbackSearchTsQuery,
  buildRestrictedScopeSql,
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

describe("raw SQL restricted-scope adapter", () => {
  const cases = [
    { name: "undefined denies restricted", allowed: undefined, article: ["financial"], access: false },
    { name: "empty denies restricted", allowed: [], article: ["financial"], access: false },
    { name: "unrestricted article", allowed: [], article: [], access: true },
    { name: "disjoint denial", allowed: ["hr"], article: ["financial"], access: false },
    { name: "single overlap", allowed: ["hr"], article: ["financial", "hr"], access: true },
    { name: "multi-scope union", allowed: ["financial", "hr"], article: ["hr"], access: true },
    { name: "wildcard", allowed: ["*"], article: ["financial"], access: true },
  ] as const;

  for (const matrixCase of cases) {
    it(matrixCase.name, () => {
      const allowedScopes: string[] | undefined = matrixCase.allowed
        ? [...matrixCase.allowed]
        : undefined;
      const articleScopes: string[] = [...matrixCase.article];
      const clauses = buildRestrictedScopeSql(allowedScopes);
      if (allowedScopes?.includes("*")) {
        assert.deepEqual(clauses, []);
        assert.equal(matrixCase.access, true);
        return;
      }

      assert.equal(clauses.length, 1);
      const parameterizedScopes = clauses[0].values.find(Array.isArray) as
        | string[]
        | undefined;
      const effectiveAccess = articleScopes.length === 0 || Boolean(
        parameterizedScopes?.some((scope) => articleScopes.includes(scope)),
      );
      assert.equal(effectiveAccess, matrixCase.access);
    });
  }
});
