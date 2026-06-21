import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSearchResultHydrationWhere } from "@/lib/wiki-search-results";

describe("wiki search result hydration", () => {
  it("keeps deleted articles out for human/admin sessions", () => {
    assert.deepEqual(
      buildSearchResultHydrationWhere(["article-a", "article-b"], ["*"]),
      {
        id: { in: ["article-a", "article-b"] },
        deletedAt: null,
      },
    );
  });

  it("re-applies unrestricted filtering for anonymous users", () => {
    assert.deepEqual(
      buildSearchResultHydrationWhere(["article-a"], undefined),
      {
        id: { in: ["article-a"] },
        deletedAt: null,
        restrictedTags: { isEmpty: true },
      },
    );
  });

  it("re-applies scoped access for API callers", () => {
    assert.deepEqual(
      buildSearchResultHydrationWhere(["article-a"], ["scope-a"]),
      {
        id: { in: ["article-a"] },
        deletedAt: null,
        OR: [
          { restrictedTags: { isEmpty: true } },
          { restrictedTags: { hasSome: ["scope-a"] } },
        ],
      },
    );
  });
});
