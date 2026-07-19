import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { buildRestrictedScopeSql } from "@/lib/memory/article-search";
import { prisma } from "@/lib/prisma";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable must be set for tests");
}

test("raw SQL restricted-scope adapter executes the canonical authorization matrix", async () => {
  const runId = crypto.randomUUID();
  const topicId = `scope-sql-topic-${runId}`;
  const articleIds = {
    unrestricted: `scope-sql-open-${runId}`,
    financial: `scope-sql-financial-${runId}`,
    hr: `scope-sql-hr-${runId}`,
  };

  await prisma.topic.create({
    data: { id: topicId, name: `Scope SQL ${runId}`, slug: `scope-sql-${runId}` },
  });

  try {
    await prisma.article.createMany({
      data: [
        {
          id: articleIds.unrestricted,
          topicId,
          title: "Unrestricted",
          slug: `open-${runId}`,
          content: "Open article",
          restrictedTags: [],
        },
        {
          id: articleIds.financial,
          topicId,
          title: "Financial",
          slug: `financial-${runId}`,
          content: "Financial article",
          restrictedTags: ["financial"],
        },
        {
          id: articleIds.hr,
          topicId,
          title: "HR",
          slug: `hr-${runId}`,
          content: "HR article",
          restrictedTags: ["hr"],
        },
      ],
    });

    const matrix: Array<{
      name: string;
      allowed: string[] | undefined;
      expected: string[];
    }> = [
      { name: "undefined", allowed: undefined, expected: [articleIds.unrestricted] },
      { name: "empty", allowed: [], expected: [articleIds.unrestricted] },
      { name: "disjoint", allowed: ["legal"], expected: [articleIds.unrestricted] },
      {
        name: "overlap",
        allowed: ["financial"],
        expected: [articleIds.financial, articleIds.unrestricted],
      },
      {
        name: "multi-scope union",
        allowed: ["financial", "hr"],
        expected: [articleIds.financial, articleIds.hr, articleIds.unrestricted],
      },
      {
        name: "wildcard",
        allowed: ["*"],
        expected: [articleIds.financial, articleIds.hr, articleIds.unrestricted],
      },
    ];

    const fixtureIds = Object.values(articleIds);
    for (const matrixCase of matrix) {
      const scopeClauses = buildRestrictedScopeSql(matrixCase.allowed);
      const scopePredicate = scopeClauses.length > 0
        ? Prisma.join(scopeClauses, " AND ")
        : Prisma.sql`TRUE`;
      const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT a.id
        FROM public."Article" AS a
        WHERE a.id IN (${Prisma.join(fixtureIds)})
          AND ${scopePredicate}
        ORDER BY a.id
      `);

      assert.deepEqual(
        rows.map((row) => row.id),
        [...matrixCase.expected].sort(),
        matrixCase.name,
      );
    }
  } finally {
    await prisma.article.deleteMany({ where: { topicId } });
    await prisma.topic.delete({ where: { id: topicId } });
  }
});
