import assert from "node:assert/strict";
import test from "node:test";
import { syncArticleRelations } from "@/lib/articles/relations";

function relationTx() {
  const calls: Array<{ method: "deleteMany" | "createMany"; args: unknown }> = [];

  return {
    calls,
    tx: {
      articleRelation: {
        deleteMany: async (args: unknown) => {
          calls.push({ method: "deleteMany", args });
        },
        createMany: async (args: unknown) => {
          calls.push({ method: "createMany", args });
        },
      },
    },
  };
}

test("syncArticleRelations leaves existing relations untouched when relatedArticleIds is omitted", async () => {
  const { calls, tx } = relationTx();

  await syncArticleRelations(tx, "article-1", undefined);

  assert.deepEqual(calls, []);
});

test("syncArticleRelations clears existing relations when relatedArticleIds is an empty array", async () => {
  const { calls, tx } = relationTx();

  await syncArticleRelations(tx, "article-1", []);

  assert.deepEqual(calls, [
    {
      method: "deleteMany",
      args: { where: { sourceId: "article-1" } },
    },
  ]);
});

test("syncArticleRelations replaces explicit relations and ignores self references", async () => {
  const { calls, tx } = relationTx();

  await syncArticleRelations(tx, "article-1", ["article-2", "article-1", "article-3"]);

  assert.deepEqual(calls, [
    {
      method: "deleteMany",
      args: { where: { sourceId: "article-1" } },
    },
    {
      method: "createMany",
      args: {
        data: [
          { sourceId: "article-1", targetId: "article-2" },
          { sourceId: "article-1", targetId: "article-3" },
        ],
        skipDuplicates: true,
      },
    },
  ]);
});
