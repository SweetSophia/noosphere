import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  buildScopeFilter,
  canAccessScopes,
  resolveScopeAccess,
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

  test("empty scopes preserves extraWhere restrictedTags with AND", () => {
    const extraWhere = { restrictedTags: { hasSome: ["existing"] } };
    const filter = buildScopeFilter([], extraWhere);
    assert.deepEqual(filter, {
      AND: [extraWhere, { restrictedTags: { isEmpty: true } }],
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

  test("specific scopes preserves extraWhere OR with AND", () => {
    const extraWhere = {
      OR: [{ status: "published" }, { status: "reviewed" }],
    };
    const filter = buildScopeFilter(["scope-a"], extraWhere);
    assert.deepEqual(filter, {
      AND: [
        extraWhere,
        {
          OR: [
            { restrictedTags: { isEmpty: true } },
            { restrictedTags: { hasSome: ["scope-a"] } },
          ],
        },
      ],
    });
  });

  test("specific scopes preserves extraWhere restrictedTags with AND", () => {
    const extraWhere = { restrictedTags: { hasSome: ["existing"] } };
    const filter = buildScopeFilter(["scope-a"], extraWhere);
    assert.deepEqual(filter, {
      AND: [
        extraWhere,
        {
          OR: [
            { restrictedTags: { isEmpty: true } },
            { restrictedTags: { hasSome: ["scope-a"] } },
          ],
        },
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

describe("canonical authorization matrix", () => {
  const cases = [
    { name: "undefined", allowed: undefined, article: ["financial"], access: false, kind: "unrestricted" },
    { name: "empty", allowed: [], article: ["financial"], access: false, kind: "unrestricted" },
    { name: "unrestricted", allowed: [], article: [], access: true, kind: "unrestricted" },
    { name: "disjoint", allowed: ["hr"], article: ["financial"], access: false, kind: "scoped" },
    { name: "overlap", allowed: ["hr"], article: ["financial", "hr"], access: true, kind: "scoped" },
    { name: "union", allowed: ["financial", "hr"], article: ["hr"], access: true, kind: "scoped" },
    { name: "wildcard", allowed: ["*"], article: ["financial"], access: true, kind: "all" },
  ] as const;

  for (const matrixCase of cases) {
    test(matrixCase.name, () => {
      assert.equal(
        canAccessScopes([...matrixCase.article], matrixCase.allowed ? [...matrixCase.allowed] : undefined),
        matrixCase.access,
      );
      assert.equal(
        resolveScopeAccess(matrixCase.allowed ? [...matrixCase.allowed] : undefined).kind,
        matrixCase.kind,
      );
    });
  }

  test("wildcard bypass preserves unrelated Prisma predicates", () => {
    assert.deepEqual(buildScopeFilter(["*"], {
      deletedAt: null,
      status: "published",
      hybridLifecycle: "serving",
      consentReady: true,
    }), {
      deletedAt: null,
      status: "published",
      hybridLifecycle: "serving",
      consentReady: true,
    });
  });
});
