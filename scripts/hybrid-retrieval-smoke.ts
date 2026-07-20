import assert from "node:assert/strict";

import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import {
  buildHybridCacheHitSql,
  buildHybridMissSql,
} from "@/lib/memory/hybrid-retrieval-sql";
import {
  parseHybridQueryRows,
  searchHybridArticles,
} from "@/lib/memory/hybrid-retrieval-runtime";
import { readHybridRetrievalConfig } from "@/lib/memory/hybrid-retrieval";

const databaseUrl = requireEnvironment("DATABASE_URL");
const profileId = requireEnvironment("NOOSPHERE_PHASE_C_TEST_PROFILE_ID");
const adminDatabaseUrl = requireEnvironment("NOOSPHERE_PHASE_C_ADMIN_DATABASE_URL");
const bootstrapDatabaseUrl = requireEnvironment("NOOSPHERE_PHASE_C_BOOTSTRAP_DATABASE_URL");

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const adminPool = new Pool({ connectionString: adminDatabaseUrl, max: 1 });
const bootstrapPool = new Pool({ connectionString: bootstrapDatabaseUrl, max: 1 });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

type RawRows = Parameters<typeof parseHybridQueryRows>[0];

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Phase C SQL smoke requires ${name}`);
  return value;
}

async function execute(query: Prisma.Sql) {
  const rows = await prisma.$transaction(
    (tx) => tx.$queryRaw<RawRows>(query),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
  return parseHybridQueryRows(rows);
}

async function expectCacheInvalidatedBy(
  label: string,
  mutation: () => Promise<unknown>,
): Promise<void> {
  const before = await execute(buildHybridMissSql({
    query: "hybrid recall",
    profileId,
    limit: 10,
    offset: 0,
    filters: { allowedScopes: ["*"] },
    vectorLiteral: "[1,0,0]",
  }));
  await mutation();
  const stale = await execute(buildHybridCacheHitSql({
    query: "hybrid recall",
    profileId,
    limit: 10,
    offset: 0,
    filters: { allowedScopes: ["*"] },
    expectedEpoch: before.epoch,
    candidates: before.candidates,
  }));
  assert.equal(stale.cacheValid, false, `${label} must invalidate a prior cache set`);
  assert.deepEqual(stale.rows, [], `${label} must never hydrate stale cache content`);
}

async function exerciseAuthorizationBatchBoundary(): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "Article" (
      id, title, slug, content, excerpt, status, confidence, "topicId",
      "restrictedTags", "createdAt", "updatedAt"
    )
    SELECT
      'phase-c-batch-' || pg_catalog.lpad(series.value::text, 4, '0'),
      'Phase C authorization batch boundary',
      'phase-c-batch-' || pg_catalog.lpad(series.value::text, 4, '0'),
      'authorization batch boundary',
      'batch',
      'published',
      'low',
      'hybrid-topic',
      ARRAY[]::text[],
      '2026-02-01 00:00:00+00'::timestamptz + series.value * interval '1 second',
      '2026-02-01 00:00:00+00'::timestamptz + series.value * interval '1 second'
    FROM pg_catalog.generate_series(1, 1001) AS series(value)
  `);

  try {
    await bootstrapPool.query(
      `INSERT INTO noosphere_hybrid.article_embedding (
         article_id, profile_id, revision, content_hash, dimensions, embedding
       )
       SELECT article.id, $1::uuid, state.revision,
              noosphere_hybrid.canonical_hash(article.title,article.excerpt,article.content,32768),
              3, '[0,1,0]'::noosphere_vector.vector
       FROM public."Article" AS article
       JOIN noosphere_hybrid.article_embedding_state AS state ON state.article_id=article.id
       WHERE article.id LIKE 'phase-c-batch-%'`,
      [profileId],
    );

    const result = await execute(buildHybridMissSql({
      query: "authorization batch boundary",
      profileId,
      limit: 200,
      offset: 0,
      filters: { allowedScopes: [], status: "published", confidence: "low" },
      vectorLiteral: "[0,1,0]",
    }));
    const expectedIds = Array.from(
      { length: 200 },
      (_, index) => `phase-c-batch-${String(1001 - index).padStart(4, "0")}`,
    );
    assert.deepEqual(
      result.candidates.map(({ id }) => id),
      expectedIds,
      "batched authorization must preserve the exact global top-200 order",
    );
    assert.deepEqual(
      result.candidates.map(({ vectorRank }) => vectorRank),
      Array.from({ length: 200 }, (_, index) => index + 1),
      "batched authorization must assign one global deterministic vector rank",
    );
  } finally {
    await prisma.$executeRaw(Prisma.sql`
      DELETE FROM "Article" WHERE id LIKE 'phase-c-batch-%'
    `);
  }
}

async function main(): Promise<void> {
try {
  const publicMiss = await execute(buildHybridMissSql({
    query: "hybrid recall",
    profileId,
    limit: 1,
    offset: 0,
    filters: { allowedScopes: [] },
    vectorLiteral: "[1,0,0]",
  }));
  assert.equal(publicMiss.cacheValid, true);
  assert.equal(publicMiss.rows.length, 1);
  assert.deepEqual(
    publicMiss.candidates.map(({ id }) => id).sort(),
    ["phase-c-public-a", "phase-c-public-b"],
  );
  assert.equal(publicMiss.rows[0].relevanceScore, 1);

  const financialMiss = await execute(buildHybridMissSql({
    query: "hybrid recall",
    profileId,
    limit: 2,
    offset: 0,
    filters: { allowedScopes: ["financial"] },
    vectorLiteral: "[1,0,0]",
  }));
  assert.equal(financialMiss.cacheValid, true);
  assert.equal(financialMiss.candidates.length, 3, "cache stores the complete fused set before paging");
  assert.equal(financialMiss.rows.length, 2);
  assert.equal(financialMiss.rows[0].relevanceScore, 1);
  assert.ok(financialMiss.rows[1].relevanceScore <= 1);

  const repeat = await execute(buildHybridMissSql({
    query: "hybrid recall",
    profileId,
    limit: 2,
    offset: 0,
    filters: { allowedScopes: ["financial"] },
    vectorLiteral: "[1,0,0]",
  }));
  assert.deepEqual(repeat.candidates, financialMiss.candidates, "RRF order must be deterministic");

  const hit = await execute(buildHybridCacheHitSql({
    query: "hybrid recall",
    profileId,
    limit: 2,
    offset: 0,
    filters: { allowedScopes: ["financial"] },
    expectedEpoch: financialMiss.epoch,
    candidates: financialMiss.candidates,
  }));
  assert.equal(hit.cacheValid, true);
  assert.deepEqual(hit.rows.map(({ id }) => id), financialMiss.rows.map(({ id }) => id));

  const scopeMismatch = await execute(buildHybridCacheHitSql({
    query: "hybrid recall",
    profileId,
    limit: 10,
    offset: 0,
    filters: { allowedScopes: [] },
    expectedEpoch: financialMiss.epoch,
    candidates: financialMiss.candidates,
  }));
  assert.equal(scopeMismatch.cacheValid, false);
  assert.deepEqual(scopeMismatch.rows, []);

  const epochMismatch = await execute(buildHybridCacheHitSql({
    query: "hybrid recall",
    profileId,
    limit: 10,
    offset: 0,
    filters: { allowedScopes: ["financial"] },
    expectedEpoch: String(BigInt(financialMiss.epoch) + 1n),
    candidates: financialMiss.candidates,
  }));
  assert.equal(epochMismatch.cacheValid, false);
  assert.deepEqual(epochMismatch.rows, []);

  const draft = await execute(buildHybridMissSql({
    query: "hybrid recall",
    profileId,
    limit: 10,
    offset: 0,
    filters: { allowedScopes: ["private"], status: "draft" },
    vectorLiteral: "[1,0,0]",
  }));
  assert.deepEqual(draft.rows.map(({ id }) => id), ["phase-c-private"]);

  const authorizationMatrix = [
    { label: "undefined", scopes: undefined, expected: ["phase-c-public-a", "phase-c-public-b"] },
    { label: "empty", scopes: [] as string[], expected: ["phase-c-public-a", "phase-c-public-b"] },
    { label: "disjoint", scopes: ["unrelated"], expected: ["phase-c-public-a", "phase-c-public-b"] },
    {
      label: "multi-scope union",
      scopes: ["financial", "private"],
      expected: ["phase-c-financial", "phase-c-private", "phase-c-public-a", "phase-c-public-b"],
    },
    {
      label: "wildcard",
      scopes: ["*"],
      expected: ["phase-c-financial", "phase-c-private", "phase-c-public-a", "phase-c-public-b"],
    },
  ];
  for (const matrixCase of authorizationMatrix) {
    const result = await execute(buildHybridMissSql({
      query: "hybrid recall",
      profileId,
      limit: 10,
      offset: 0,
      filters: { allowedScopes: matrixCase.scopes },
      vectorLiteral: "[1,0,0]",
    }));
    assert.deepEqual(
      result.candidates.map(({ id }) => id).sort(),
      matrixCase.expected,
      `${matrixCase.label} candidate authorization`,
    );
    assert.deepEqual(
      result.rows.map(({ id }) => id).sort(),
      matrixCase.expected,
      `${matrixCase.label} final hydration authorization`,
    );
  }

  const relaxed = await execute(buildHybridMissSql({
    query: "the hybrid recall",
    profileId,
    limit: 10,
    offset: 0,
    filters: { allowedScopes: [] },
    vectorLiteral: "[1,0,0]",
  }));
  assert.ok(relaxed.rows.length > 0, "zero-result strict search must use bounded lexical fallback");

  await exerciseAuthorizationBatchBoundary();

  if (process.env.NOOSPHERE_HYBRID_RETRIEVAL_ENABLED === "true") {
    const runtimeRows = await searchHybridArticles(
      prisma,
      {
        query: "hybrid recall",
        limit: 2,
        offset: 0,
        filters: {},
        allowedScopes: [],
      },
      readHybridRetrievalConfig(process.env),
      process.env,
    );
    assert.equal(runtimeRows.length, 2, "runtime must embed, fuse, authorize, and hydrate");
  }

  const topicRows = await prisma.$queryRaw<Array<{ name: string }>>(Prisma.sql`
    SELECT name FROM "Topic" WHERE id = 'hybrid-topic'
  `);
  assert.equal(topicRows.length, 1);
  const topicName = topicRows[0].name;

  await expectCacheInvalidatedBy("Article mutation", () =>
    prisma.$executeRaw(Prisma.sql`
      UPDATE "Article" SET "authorName" = 'Phase C cache mutation'
      WHERE id = 'phase-c-public-a'
    `),
  );
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "Article" SET "authorName" = NULL WHERE id = 'phase-c-public-a'
  `);

  await expectCacheInvalidatedBy("Topic mutation", () =>
    prisma.$executeRaw(Prisma.sql`
      UPDATE "Topic" SET name = ${`${topicName} cache mutation`} WHERE id = 'hybrid-topic'
    `),
  );
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "Topic" SET name = ${topicName} WHERE id = 'hybrid-topic'
  `);

  await expectCacheInvalidatedBy("Tag mutation", () =>
    prisma.$executeRaw(Prisma.sql`
      INSERT INTO "Tag" (id, name, slug, "createdAt")
      VALUES ('phase-c-cache-tag', 'Phase C cache tag', 'phase-c-cache-tag', clock_timestamp())
    `),
  );
  await expectCacheInvalidatedBy("ArticleTag insertion", () =>
    prisma.$executeRaw(Prisma.sql`
      INSERT INTO "ArticleTag" ("articleId", "tagId")
      VALUES ('phase-c-public-a', 'phase-c-cache-tag')
    `),
  );
  await expectCacheInvalidatedBy("ArticleTag deletion", () =>
    prisma.$executeRaw(Prisma.sql`
      DELETE FROM "ArticleTag"
      WHERE "articleId" = 'phase-c-public-a' AND "tagId" = 'phase-c-cache-tag'
    `),
  );
  await expectCacheInvalidatedBy("Tag deletion", () =>
    prisma.$executeRaw(Prisma.sql`
      DELETE FROM "Tag" WHERE id = 'phase-c-cache-tag'
    `),
  );

  await expectCacheInvalidatedBy("vector mutation", () =>
    bootstrapPool.query(
      `UPDATE noosphere_hybrid.article_embedding
       SET embedding='[0,0,0]'::noosphere_vector.vector
       WHERE article_id='phase-c-public-a' AND profile_id=$1::uuid`,
      [profileId],
    ),
  );
  const zeroCoverage = await prisma.$queryRaw<
    Array<{ eligible_count: bigint; ready_count: bigint; coverage: string }>
  >(Prisma.sql`
    SELECT eligible_count, ready_count, coverage::text
    FROM noosphere_hybrid_c.query_profile_snapshot(${profileId}::uuid)
  `);
  assert.equal(zeroCoverage.length, 1);
  assert.equal(
    zeroCoverage[0].ready_count,
    zeroCoverage[0].eligible_count - 1n,
    "zero cosine documents cannot count as ready",
  );
  assert.ok(Number(zeroCoverage[0].coverage) < 1);
  const zeroMembership = await prisma.$queryRaw<Array<{ article_id: string }>>(Prisma.sql`
    SELECT * FROM noosphere_hybrid_c.current_vector_membership(
      ${profileId}::uuid, ARRAY['phase-c-public-a']::text[]
    )
  `);
  assert.deepEqual(zeroMembership, []);
  await bootstrapPool.query(
    `UPDATE noosphere_hybrid.article_embedding
     SET embedding='[1,0,0]'::noosphere_vector.vector
     WHERE article_id='phase-c-public-a' AND profile_id=$1::uuid`,
    [profileId],
  );

  await expectCacheInvalidatedBy("consent mutation", () =>
    adminPool.query("SELECT noosphere_hybrid_b.set_embedding_consent(false,false)"),
  );
  await adminPool.query("SELECT noosphere_hybrid_b.set_embedding_consent(true,true)");

  await expectCacheInvalidatedBy("lifecycle mutation", () =>
    prisma.$executeRaw(Prisma.sql`
      UPDATE "Article" SET "deletedAt" = clock_timestamp()
      WHERE id = 'phase-c-public-b'
    `),
  );
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "Article" SET "deletedAt" = NULL WHERE id = 'phase-c-public-b'
  `);

  console.log("[hybrid-retrieval-smoke] PASS: provider, exact scope matrix, miss, cache hit, mutation invalidation, fallback, and pagination invariants.");
} finally {
  await prisma.$disconnect();
  await pool.end();
  await adminPool.end();
  await bootstrapPool.end();
}
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
