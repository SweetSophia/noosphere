import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { checkFixtureFreshness } from "./hybrid-shadow-freshness";
import { buildReport, parseArgs, runPath, writeReport, type QuerySet } from "./hybrid-shadow-eval";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";

// Explicit opt-in test URL only. This suite creates a connection-local temporary
// Article table, never writes the application corpus, and does not use Redis.
test("freshness exact lookup enforces scope, deletion and ambiguity without metadata leaks", async () => {
  assert.ok(process.env.SHADOW_TEST_DATABASE_URL, "set SHADOW_TEST_DATABASE_URL to an isolated fixture database");
  const pool = new Pool({ connectionString: process.env.SHADOW_TEST_DATABASE_URL, max: 1 });
  const dir = await mkdtemp(path.join(tmpdir(), "freshness-test-"));
  try {
    await pool.query(`CREATE TEMP TABLE "Article" (slug text, "restrictedTags" text[], "deletedAt" timestamp, title text, status text)`);
    await pool.query(`INSERT INTO "Article" VALUES
      ('visible', '{}', NULL, 'public-title', 'DRAFT'),
      ('hidden', '{secret-tag}', NULL, 'secret-title', 'PUBLISHED'),
      ('deleted', '{}', now(), 'deleted-title', 'PUBLISHED'),
      ('deleted-hidden', '{secret-tag}', now(), 'secret-title', 'DRAFT'),
      ('duplicate', '{}', NULL, 'first-topic', 'DRAFT'),
      ('duplicate', '{}', NULL, 'second-topic', 'PUBLISHED'),
      ('mixed', '{}', NULL, 'public-title', 'DRAFT'),
      ('mixed', '{secret-tag}', NULL, 'secret-title', 'DRAFT'),
      ('hidden-duplicate', '{secret-tag}', NULL, 'secret-title', 'DRAFT'),
      ('hidden-duplicate', '{secret-tag}', NULL, 'secret-title', 'DRAFT')`);
    await pool.query(`ALTER TABLE "Article" ADD COLUMN id text;
      ALTER TABLE "Article" ADD COLUMN "recallQuarantinedAt" timestamp;
      CREATE TEMP TABLE "MemoryLineageState" (id text, generation int, "revokedAt" timestamp);
      CREATE TEMP TABLE "MemoryProvenanceEdge" ("articleId" text, "sourceGroupId" text, "lineageStateId" text, "generationSnapshot" int)`);
    const set: QuerySet = { version: 1, queries: [{ id: "query-one", query: "search misses everything", relevance: {
      visible: 3, hidden: 3, missing: 3, deleted: 3, "deleted-hidden": 3, duplicate: 3, mixed: 3, "hidden-duplicate": 0,
    } }] };
    for (const scopes of [["secret-tag"], ["*", "secret-tag"]]) {
      await assert.rejects(checkFixtureFreshness(pool, set, scopes), /supports only unscoped or admin/);
    }
    const original = JSON.stringify(set);
    const unscoped = await checkFixtureFreshness(pool, set, undefined);
    assert.deepEqual(unscoped.judgments.map((j) => j.status), ["visible", "unknown/not-visible", "unknown/not-visible", "unknown/not-visible", "unknown/not-visible", "ambiguous", "visible", "unknown/not-visible"]);
    const authorized = await checkFixtureFreshness(pool, set, undefined, true);
    assert.deepEqual(authorized.judgments.map((j) => j.status), ["visible", "excluded-by-scope", "corpus-absent", "corpus-absent", "corpus-absent", "ambiguous", "ambiguous", "ambiguous"]);
    const admin = await checkFixtureFreshness(pool, set, ["*"]);
    assert.equal(admin.judgments[1].status, "visible");
    assert.deepEqual(admin.counts, { visible: 2, "excluded-by-scope": 0, "corpus-absent": 3, "unknown/not-visible": 0, ambiguous: 3 });
    assert.equal(unscoped.evidenceScope, "unscoped");
    assert.equal(authorized.evidenceScope, "admin");
    assert.equal(authorized.evaluationScope, "unscoped");
    assert.equal(authorized.outcome, "needs-review");
    assert.ok(Date.parse(authorized.startedAt) <= Date.parse(authorized.checkedAt));
    assert.equal((await checkFixtureFreshness(pool, { version: 1, queries: [{ ...set.queries[0], relevance: { visible: 3 } }] }, undefined)).outcome, "clear");
    const ranks = await runPath("keyword", { search: async () => [] }, set, 10);
    const report = buildReport(set, ranks, ranks, parseArgs([]), {}, authorized);
    const unchecked = buildReport(set, ranks, ranks, parseArgs([]), {});
    assert.deepEqual(report.metrics, unchecked.metrics, "freshness must not change scores or denominators");
    assert.equal(report.metrics.keyword.recall, 0, "visible judgment can be a search miss, not absent");
    assert.equal(JSON.stringify(set), original);
    const files = await writeReport(report, dir);
    const persisted = JSON.parse(await readFile(files.aggregatePath, "utf8"));
    assert.deepEqual(persisted.freshness, authorized);
    const md = await readFile(files.summaryPath, "utf8");
    for (const text of [authorized.checkedAt, "evidence scope: admin", "needs-review", "corpus-absent: 3"]) assert.ok(md.includes(text));
    for (const evidence of [JSON.stringify(unscoped), JSON.stringify(authorized), JSON.stringify(admin), md]) {
      assert.doesNotMatch(evidence, /secret-tag|secret-title|deleted-title|first-topic|second-topic|public-title/);
    }
    await pool.query('ALTER TABLE "Article" DROP COLUMN "deletedAt"');
    await assert.rejects(checkFixtureFreshness(pool, set, undefined), /deletedAt/);
  } finally {
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  }
});

test("freshness excludes quarantine and invalid provenance before duplicate aggregation", async () => {
  assert.ok(process.env.SHADOW_TEST_DATABASE_URL, "isolated fixture database required");
  const pool = new Pool({ connectionString: process.env.SHADOW_TEST_DATABASE_URL, max: 1 });
  try {
    await pool.query(`
      CREATE TEMP TABLE "Article" (id text, slug text, "restrictedTags" text[], "deletedAt" timestamp, "recallQuarantinedAt" timestamp);
      CREATE TEMP TABLE "MemoryLineageState" (id text, generation int, "revokedAt" timestamp);
      CREATE TEMP TABLE "MemoryProvenanceEdge" ("articleId" text, "sourceGroupId" text, "lineageStateId" text, "generationSnapshot" int);
      INSERT INTO "Article" VALUES
        ('private-q', 'quarantined', '{}', NULL, now()),
        ('private-a', 'quarantine-duplicate', '{}', NULL, NULL),
        ('private-b', 'quarantine-duplicate', '{private-tag}', NULL, now()),
        ('private-r', 'revoked', '{}', NULL, NULL),
        ('private-s', 'stale', '{}', NULL, NULL),
        ('private-g', 'valid-group', '{}', NULL, NULL),
        ('private-m', 'mixed-group', '{}', NULL, NULL),
        ('private-d', 'lineage-duplicate', '{}', NULL, NULL),
        ('private-e', 'lineage-duplicate', '{}', NULL, NULL),
        ('private-h', 'hidden-revoked', '{private-tag}', NULL, NULL),
        ('private-n', 'no-provenance', '{}', NULL, NULL);
      INSERT INTO "MemoryLineageState" VALUES
        ('private-valid', 2, NULL), ('private-revoked', 2, now()), ('private-stale', 3, NULL);
      INSERT INTO "MemoryProvenanceEdge" VALUES
        ('private-r', 'private-group', 'private-revoked', 2),
        ('private-s', 'private-group', 'private-stale', 2),
        ('private-g', 'private-group', 'private-revoked', 2),
        ('private-g', 'private-other', 'private-valid', 2),
        ('private-m', 'private-group', 'private-valid', 2),
        ('private-m', 'private-group', 'private-revoked', 2),
        ('private-m', 'private-other', 'private-stale', 2),
        ('private-e', 'private-group', 'private-revoked', 2),
        ('private-h', 'private-group', 'private-revoked', 2);
    `);
    const statuses = {
      quarantined: false, "quarantine-duplicate": true, revoked: false, stale: false,
      "valid-group": true, "mixed-group": false, "lineage-duplicate": true,
      "hidden-revoked": false, "no-provenance": true,
    };
    for (const [slug, eligible] of Object.entries(statuses)) {
      const set: QuerySet = { version: 1, queries: [{ id: "fixture", query: "miss", relevance: { [slug]: 3 } }] };
      const original = JSON.stringify(set);
      for (const [scopes, adminEvidence] of [[undefined, false], [undefined, true], [["*"], false]] as const) {
        const report = await checkFixtureFreshness(pool, set, scopes ? [...scopes] : undefined, adminEvidence);
        assert.equal(report.judgments[0].status, eligible ? "visible" : scopes || adminEvidence ? "corpus-absent" : "unknown/not-visible", slug);
        assert.equal(report.outcome, eligible ? "clear" : "needs-review", slug);
        assert.doesNotMatch(JSON.stringify(report), /private-/);
        assert.equal(JSON.stringify(set), original);
      }
    }
    // Make the quarantined duplicate unrestricted too: neither scope may count it.
    await pool.query(`UPDATE "Article" SET "restrictedTags" = '{}' WHERE id = 'private-b'`);
    const duplicate: QuerySet = { version: 1, queries: [{ id: "fixture", query: "miss", relevance: { "quarantine-duplicate": 3 } }] };
    assert.equal((await checkFixtureFreshness(pool, duplicate, undefined)).outcome, "clear");
  } finally { await pool.end(); }
});

test("real CLI preflight needs no hybrid or Redis config and persists no metric report", async () => {
  assert.ok(process.env.SHADOW_TEST_DATABASE_URL, "isolated fixture database required");
  const dir = await mkdtemp(path.join(tmpdir(), "freshness-cli-"));
  try {
    const env = { ...process.env, DATABASE_URL: process.env.SHADOW_TEST_DATABASE_URL,
      REDIS_URL: "redis://127.0.0.1:1", NOOSPHERE_HYBRID_QUERY_PROFILE_ID: "",
      NOOSPHERE_HYBRID_CACHE_HMAC_ACTIVE_VERSION: "", NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64: "" };
    const cli = path.resolve(import.meta.dirname, "hybrid-shadow-eval.ts");
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", cli, "--preflight-only", "--out", dir], { env, timeout: 20000 });
    assert.doesNotMatch(result.stdout, /\[keyword\]|\[hybrid\]|aggregate:/);
    assert.equal(result.stderr, "");
    const names = await readdir(dir);
    assert.equal(names.length, 1);
    assert.match(names[0], /^freshness-.*\.json$/);
    const file = path.join(dir, names[0]);
    const report = JSON.parse(await readFile(file, "utf8"));
    assert.equal(report.freshness.evidenceScope, "unscoped");
    assert.equal(report.metrics, undefined);
    assert.equal(report.freshness.counts["corpus-absent"], 0);
    assert.equal(report.freshness.counts["excluded-by-scope"], 0);
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o077, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
