import assert from "node:assert/strict";
import test from "node:test";
import { isAccessibleRelatedArticle } from "@/lib/articles/relations";

type Relation = {
  target: {
    id: string;
    title: string;
    restrictedTags: string[];
    deletedAt: Date | null;
  };
};

function rel(overrides: Partial<Relation["target"]> = {}): Relation {
  return {
    target: {
      id: "t-1",
      title: "T",
      restrictedTags: [],
      deletedAt: null,
      ...overrides,
    },
  };
}

test("isAccessibleRelatedArticle keeps an unrestricted, non-deleted relation", () => {
  assert.equal(
    isAccessibleRelatedArticle(rel(), ["health"]),
    true,
  );
});

test("isAccessibleRelatedArticle keeps a non-deleted relation when caller's scope matches the target's restrictedTags", () => {
  assert.equal(
    isAccessibleRelatedArticle(
      rel({ restrictedTags: ["financial"] }),
      ["financial"],
    ),
    true,
  );
});

test("isAccessibleRelatedArticle drops a relation whose target is soft-deleted (unrestricted target)", () => {
  assert.equal(
    isAccessibleRelatedArticle(
      rel({ deletedAt: new Date("2024-01-01") }),
      ["health"],
    ),
    false,
  );
});

test("isAccessibleRelatedArticle drops a relation whose target is soft-deleted (restricted target)", () => {
  assert.equal(
    isAccessibleRelatedArticle(
      rel({ restrictedTags: ["financial"], deletedAt: new Date("2024-01-01") }),
      ["financial"],
    ),
    false,
  );
});

test("isAccessibleRelatedArticle drops a relation when caller's scope does not match the target's restrictedTags", () => {
  assert.equal(
    isAccessibleRelatedArticle(
      rel({ restrictedTags: ["financial"] }),
      ["health"],
    ),
    false,
  );
});

test("isAccessibleRelatedArticle grants admin ('*') scope access to a restricted, non-deleted target", () => {
  assert.equal(
    isAccessibleRelatedArticle(
      rel({ restrictedTags: ["financial"] }),
      ["*"],
    ),
    true,
  );
});

test("isAccessibleRelatedArticle denies a restricted target for a caller with no scopes", () => {
  assert.equal(
    isAccessibleRelatedArticle(
      rel({ restrictedTags: ["financial"] }),
      [],
    ),
    false,
  );
});

test("isAccessibleRelatedArticle denies a restricted target for a caller with undefined scopes", () => {
  assert.equal(
    isAccessibleRelatedArticle(
      rel({ restrictedTags: ["financial"] }),
      undefined,
    ),
    false,
  );
});

test("isAccessibleRelatedArticle short-circuits: soft-deleted beats scope match", () => {
  // Even an admin with the matching scope cannot see a soft-deleted
  // target through the related-articles panel — soft-delete is an
  // unconditional hide.
  assert.equal(
    isAccessibleRelatedArticle(
      rel({ restrictedTags: ["financial"], deletedAt: new Date("2024-01-01") }),
      ["*"],
    ),
    false,
  );
});
