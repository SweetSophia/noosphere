import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadWikiHomeData, type WikiHomeDb } from "@/lib/wiki-home";

describe("wiki home scope filtering", () => {
  it("uses the scoped article filter for topic count aggregation", async () => {
    const calls: { method: string; where?: Record<string, unknown> }[] = [];
    const db: WikiHomeDb<unknown> = {
      topic: {
        async findMany() {
          return [];
        },
      },
      article: {
        async groupBy(args) {
          calls.push({ method: "groupBy", where: args.where });
          return [];
        },
        async findMany(args) {
          calls.push({ method: "findMany", where: args.where });
          return [];
        },
      },
    };

    await loadWikiHomeData(db, undefined);

    assert.deepEqual(
      calls.find((call) => call.method === "groupBy")?.where,
      { deletedAt: null, restrictedTags: { isEmpty: true } },
      "topic counts must use the same scoped filter as visible articles",
    );
    assert.deepEqual(
      calls.find((call) => call.method === "findMany")?.where,
      { deletedAt: null, restrictedTags: { isEmpty: true } },
      "recent articles and topic counts must stay aligned",
    );
  });
});
