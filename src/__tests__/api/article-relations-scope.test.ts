import assert from "node:assert/strict";
import test from "node:test";
import {
  filterAccessibleRelatedTargets,
  filterVisibleRelatedArticleRows,
  type ArticleRelationReader,
} from "@/lib/articles/relations";

type ArticleFixture = {
  id: string;
  restrictedTags: string[];
  deletedAt?: Date | null;
};

function relationReader(
  articles: ArticleFixture[],
): {
  calls: { method: string; args: unknown }[];
  reader: ArticleRelationReader;
} {
  const calls: { method: string; args: unknown }[] = [];
  return {
    calls,
    reader: {
      article: {
        async findMany(args: unknown) {
          calls.push({ method: "findMany", args });
          const where = (
            args as { where: { id: { in: string[] }; deletedAt?: unknown } }
          ).where;
          const inIds = new Set(where.id.in);
          const excludeDeleted = where.deletedAt === null;
          return articles
            .filter((a) => inIds.has(a.id))
            .filter((a) => !excludeDeleted || a.deletedAt == null)
            .map((a) => ({ id: a.id, restrictedTags: a.restrictedTags }));
        },
      },
    },
  };
}

test("filterAccessibleRelatedTargets returns empty for no candidates", async () => {
  const { reader } = relationReader([]);
  const result = await filterAccessibleRelatedTargets(reader, [], ["health"]);
  assert.deepEqual(result, []);
});

test("filterAccessibleRelatedTargets keeps all unrestricted articles for any caller", async () => {
  const { reader } = relationReader([
    { id: "a-1", restrictedTags: [] },
    { id: "a-2", restrictedTags: [] },
  ]);

  const result = await filterAccessibleRelatedTargets(
    reader,
    ["a-1", "a-2"],
    ["health"],
  );

  assert.deepEqual(result.sort(), ["a-1", "a-2"]);
});

test("filterAccessibleRelatedTargets drops non-existent target IDs", async () => {
  const { reader } = relationReader([
    { id: "a-1", restrictedTags: [] },
  ]);

  const result = await filterAccessibleRelatedTargets(
    reader,
    ["a-1", "ghost-id"],
    ["health"],
  );

  assert.deepEqual(result, ["a-1"]);
});

test("filterAccessibleRelatedTargets drops restricted articles outside the caller's scopes", async () => {
  const { reader } = relationReader([
    { id: "a-1", restrictedTags: [] },
    { id: "a-financial", restrictedTags: ["financial"] },
    { id: "a-health", restrictedTags: ["health"] },
  ]);

  const result = await filterAccessibleRelatedTargets(
    reader,
    ["a-1", "a-financial", "a-health"],
    ["health"],
  );

  assert.deepEqual(result.sort(), ["a-1", "a-health"]);
});

test("filterAccessibleRelatedTargets grants admin ('*') scope access to every restricted article", async () => {
  const { reader } = relationReader([
    { id: "a-financial", restrictedTags: ["financial"] },
    { id: "a-health", restrictedTags: ["health"] },
  ]);

  const result = await filterAccessibleRelatedTargets(
    reader,
    ["a-financial", "a-health"],
    ["*"],
  );

  assert.deepEqual(result.sort(), ["a-financial", "a-health"]);
});

test("filterAccessibleRelatedTargets denies all restricted articles for a caller with no scopes", async () => {
  const { reader } = relationReader([
    { id: "a-1", restrictedTags: [] },
    { id: "a-financial", restrictedTags: ["financial"] },
  ]);

  const result = await filterAccessibleRelatedTargets(
    reader,
    ["a-1", "a-financial"],
    [],
  );

  assert.deepEqual(result, ["a-1"]);
});

test("filterAccessibleRelatedTargets deduplicates the input before returning", async () => {
  const { reader } = relationReader([
    { id: "a-1", restrictedTags: [] },
  ]);

  const result = await filterAccessibleRelatedTargets(
    reader,
    ["a-1", "a-1", "a-1"],
    ["health"],
  );

  assert.deepEqual(result, ["a-1"]);
});

test("filterAccessibleRelatedTargets queries prisma with the candidate id list and excludes soft-deleted", async () => {
  const { calls, reader } = relationReader([
    { id: "a-1", restrictedTags: [] },
  ]);

  await filterAccessibleRelatedTargets(reader, ["a-1", "a-2"], ["health"]);

  assert.equal(calls.length, 1);
  const call = calls[0] as {
    method: string;
    args: { where: { id: { in: string[] }; deletedAt: unknown } };
  };
  assert.equal(call.method, "findMany");
  assert.deepEqual(call.args.where.id.in.sort(), ["a-1", "a-2"]);
  assert.equal(call.args.where.deletedAt, null);
});

test("filterAccessibleRelatedTargets drops soft-deleted candidates", async () => {
  const { reader } = relationReader([
    { id: "a-1", restrictedTags: [] },
    { id: "a-trashed", restrictedTags: [], deletedAt: new Date("2024-01-01") },
  ]);

  const result = await filterAccessibleRelatedTargets(
    reader,
    ["a-1", "a-trashed"],
    ["health"],
  );

  assert.deepEqual(result, ["a-1"]);
});

test("filterVisibleRelatedArticleRows drops soft-deleted targets before rendering", () => {
  const visible = {
    target: { id: "a-visible", restrictedTags: [], deletedAt: null },
  };
  const deleted = {
    target: { id: "a-deleted", restrictedTags: [], deletedAt: new Date("2024-01-01") },
  };

  const result = filterVisibleRelatedArticleRows([visible, deleted], ["*"]);

  assert.deepEqual(result, [visible]);
});

test("filterVisibleRelatedArticleRows keeps existing scope filtering for live targets", () => {
  const unrestricted = {
    target: { id: "a-open", restrictedTags: [], deletedAt: null },
  };
  const allowed = {
    target: { id: "a-health", restrictedTags: ["health"], deletedAt: null },
  };
  const forbidden = {
    target: { id: "a-finance", restrictedTags: ["finance"], deletedAt: null },
  };

  const result = filterVisibleRelatedArticleRows(
    [unrestricted, allowed, forbidden],
    ["health"],
  );

  assert.deepEqual(result, [unrestricted, allowed]);
});
