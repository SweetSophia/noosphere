import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  buildArticleSearchFilters, buildSearchableCTE, buildSearchTsQuery,
  buildFallbackSearchTsQuery,
} from "@/lib/memory/article-search";

after(async () => {
  await prisma.$disconnect();
  await (globalThis as unknown as { pool?: { end(): Promise<void> } }).pool?.end();
});

test("actual article CTE stems all four fields while preserving ranking and scope filters", async () => {
  const prefix = `stemming-${randomUUID()}`;
  // Allocate owned identities before setup so even a failed create is covered
  // by cleanup, and make setup atomic instead of committing partial fixtures.
  const topic = { id: `${prefix}-topic`, slug: prefix };
  const title = { id: `${prefix}-title` };
  const content = { id: `${prefix}-content` };
  const restricted = { id: `${prefix}-private` };
  const tag = { id: `${prefix}-tag` };
  try {
    await prisma.$transaction(async (tx) => {
      await tx.topic.create({ data: { id: topic.id, name: prefix, slug: prefix } });
      await tx.article.create({ data: { id: title.id, title: "running", slug: "title", content: "sleeping", excerpt: "photos", topicId: topic.id } });
      await tx.article.create({ data: { id: content.id, title: "Other", slug: "content", content: "running", topicId: topic.id } });
      await tx.article.create({ data: { id: restricted.id, title: "running", slug: "private", content: "restricted", topicId: topic.id, restrictedTags: ["team-a"] } });
      await tx.tag.create({ data: { id: tag.id, name: `deployments ${prefix}`, slug: prefix } });
      await tx.articleTag.create({ data: { articleId: title.id, tagId: tag.id } });
    });
    const search = async (query: string, allowedScopes: string[] = [], fallback = false) => {
      const cte = buildSearchableCTE(buildArticleSearchFilters({ topicSlug: topic.slug, allowedScopes }));
      const tsquery = fallback ? buildFallbackSearchTsQuery(query) : buildSearchTsQuery(query);
      assert.ok(tsquery);
      return prisma.$queryRaw<Array<{ id: string; rank: number }>>(Prisma.sql`
        WITH searchable AS (${cte}), q AS (SELECT ${tsquery} AS query)
        SELECT id, ts_rank(document, q.query)::float8 AS rank
        FROM searchable CROSS JOIN q WHERE document @@ q.query
        ORDER BY rank DESC, id
      `);
    };
    for (const query of ["run", "runs"]) {
      const rows = await search(query);
      assert.deepEqual(rows.map((r) => r.id), [title.id, content.id]);
      assert.ok(rows[0].rank > rows[1].rank && rows[1].rank > 0, "title weighting and positive ranks survive stemming");
    }
    for (const query of ["photo", "sleep", "deployment"]) {
      assert.deepEqual((await search(query)).map((r) => r.id), [title.id], `real field stemming: ${query}`);
    }
    assert.deepEqual((await search("photos", [], true)).map((r) => r.id), [title.id], "fallback and document configs agree");
    assert.deepEqual(await search("the of is"), [], "English stop-word-only query is empty");
    assert.deepEqual(await search("ran"), [], "irregular verbs do not falsely conflate");
    for (const scopes of [["*"], ["team-a"]]) {
      assert.deepEqual((await search("run", scopes)).map((r) => r.id).sort(), [title.id, content.id, restricted.id].sort());
    }
    await prisma.article.update({ where: { id: title.id }, data: { deletedAt: new Date() } });
    assert.deepEqual(await search("photo", ["*"]), [], "stemming must not bypass article eligibility");
  } finally {
    await prisma.articleTag.deleteMany({ where: { tagId: tag.id } });
    await prisma.tag.deleteMany({ where: { id: tag.id } });
    await prisma.article.deleteMany({ where: { topicId: topic.id } });
    await prisma.topic.deleteMany({ where: { id: topic.id } });
  }
});
