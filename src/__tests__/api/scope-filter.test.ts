import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  buildScopeFilter,
  canAccessScopes,
} from "@/lib/api/scope-filter";

describe("buildScopeFilter", () => {
  test("admin scope (*) returns only extraWhere", () => {
    const filter = buildScopeFilter(["*"], { status: "published" });
    assert.deepEqual(filter, { status: "published" });
  });

  test("admin scope with no extraWhere returns empty object", () => {
    const filter = buildScopeFilter(["*"]);
    assert.deepEqual(filter, {});
  });

  test("undefined scopes restricts to unrestricted articles", () => {
    const filter = buildScopeFilter(undefined);
    assert.deepEqual(filter, { restrictedTags: { isEmpty: true } });
  });

  test("empty scopes restricts to unrestricted articles", () => {
    const filter = buildScopeFilter([]);
    assert.deepEqual(filter, { restrictedTags: { isEmpty: true } });
  });

  test("empty scopes merges with extraWhere", () => {
    const filter = buildScopeFilter([], { status: "draft" });
    assert.deepEqual(filter, {
      status: "draft",
      restrictedTags: { isEmpty: true },
    });
  });

  test("specific scopes creates OR filter", () => {
    const filter = buildScopeFilter(["scope-a", "scope-b"]);
    assert.deepEqual(filter, {
      OR: [
        { restrictedTags: { isEmpty: true } },
        { restrictedTags: { hasSome: ["scope-a", "scope-b"] } },
      ],
    });
  });

  test("specific scopes with extraWhere merges correctly", () => {
    const filter = buildScopeFilter(["scope-a"], { status: "published" });
    assert.deepEqual(filter, {
      status: "published",
      OR: [
        { restrictedTags: { isEmpty: true } },
        { restrictedTags: { hasSome: ["scope-a"] } },
      ],
    });
  });
});

describe("canAccessScopes", () => {
  test("unrestricted articles are always accessible", () => {
    assert.equal(canAccessScopes([], undefined), true);
    assert.equal(canAccessScopes([], []), true);
    assert.equal(canAccessScopes([], ["scope-a"]), true);
    assert.equal(canAccessScopes([], ["*"]), true);
  });

  test("admin bypass grants access to any restricted article", () => {
    assert.equal(canAccessScopes(["secret"], ["*"]), true);
    assert.equal(canAccessScopes(["a", "b", "c"], ["*"]), true);
  });

  test("no scopes denies access to restricted articles", () => {
    assert.equal(canAccessScopes(["secret"], undefined), false);
    assert.equal(canAccessScopes(["secret"], []), false);
  });

  test("matching scope grants access", () => {
    assert.equal(canAccessScopes(["scope-a"], ["scope-a"]), true);
    assert.equal(canAccessScopes(["scope-a"], ["scope-a", "scope-b"]), true);
  });

  test("partial match grants access (any match is sufficient)", () => {
    assert.equal(canAccessScopes(["scope-a", "scope-b"], ["scope-b"]), true);
  });

  test("no matching scope denies access", () => {
    assert.equal(canAccessScopes(["scope-a"], ["scope-b"]), false);
    assert.equal(
      canAccessScopes(["scope-a", "scope-b"], ["scope-c", "scope-d"]),
      false,
    );
  });
});