import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildReport, loadQuerySet, parseArgs, runPath, writeReport, type QuerySet } from "./hybrid-shadow-eval";
import type { MemoryResult } from "@/lib/memory/types";

const fixtureDir = path.resolve(import.meta.dirname, "../src/__tests__/fixtures");
const one = { id: "query-one", query: "test query", relevance: { relevant: 3, other: 1, zero: 0 } };
const querySet = (queries = [one]): QuerySet => ({ version: 1, queries });
const row = (slug: string, metadata = {}): MemoryResult => ({
  id: slug, provider: "noosphere", sourceType: "noosphere", content: "not persisted",
  title: slug, relevanceScore: 0.5, metadata: { articleSlug: slug, ...metadata },
});
const rankings = (set: QuerySet, rows: MemoryResult[][], mode: "keyword" | "hybrid" = "hybrid") => {
  let index = 0;
  return runPath(mode, { search: async () => rows[index++] }, set, 10);
};

test("all-miss MRR is zero; empty hybrid fallback remains unknown", async () => {
  const set = querySet();
  const hybrid = await rankings(set, [[]]);
  const keyword = await rankings(set, [[]], "keyword");
  const report = buildReport(set, keyword, hybrid, parseArgs([]), {});
  assert.equal(report.metrics.hybrid.mrr, 0);
  assert.equal(report.metrics.keyword.mrr, 0);
  assert.equal(report.metrics.hybrid.recall, 0);
  assert.equal(report.metrics.hybrid.ndcg, 0);
  assert.equal(report.metrics.hybrid.fallbacks, 0);
  assert.equal(report.metrics.hybrid.fallbackUnknown, 1);
  assert.equal(report.metrics.keyword.fallbackUnknown, 0);
  assert.equal(report.perQuery[1].hybridFallback, null);
  assert.equal(report.perQuery[1].hybridFallbackReason, null);
});

test("mixed MRR includes misses and ranks beyond k up to the returned limit", async () => {
  const set = querySet([one, { ...one, id: "query-two" }, { ...one, id: "query-three" }]);
  const hybrid = await rankings(set, [[row("relevant")], [row("zero"), row("other")], []]);
  const report = buildReport(set, hybrid, hybrid, parseArgs(["--k", "1"]), {});
  assert.equal(report.metrics.hybrid.mrr, (1 + 1 / 2 + 0) / 3);
  assert.equal(report.metrics.hybrid.recall, (1 / 2 + 0 + 0) / 3);
  assert.equal(report.metrics.hybrid.fallbackUnknown, 1);
});

test("linear-gain nDCG uses full fixture IDCG, including unretrieved judgments", async () => {
  const set = querySet();
  const hybrid = await rankings(set, [[row("other")]]);
  const report = buildReport(set, hybrid, hybrid, parseArgs(["--k", "2"]), {});
  assert.equal(report.metrics.hybrid.ndcg, 1 / (3 + 1 / Math.log2(3)));
  assert.equal(report.metrics.hybrid.recall, 1 / 2);
  const noRelevant = querySet([{ ...one, relevance: { relevant: 0, other: 0, zero: 0 } }]);
  const misses = await rankings(noRelevant, [[row("zero")]]);
  const noJudgments = buildReport(noRelevant, misses, misses, parseArgs([]), {});
  assert.equal(noJudgments.metrics.hybrid.ndcg, null);
  assert.equal(noJudgments.metrics.hybrid.recall, null);
  assert.equal(noJudgments.metrics.hybrid.mrr, 0);
});

test("runPath preserves search contract and observes annotated fallback without copying arbitrary metadata", async () => {
  const set = querySet();
  const result = await runPath("hybrid", { search: async (query, options) => {
    assert.equal(query, one.query);
    assert.deepEqual(options, { limit: 7 });
    return [row("relevant", { hybridFallback: true, hybridFallbackReason: "storage_unavailable", secret: "do-not-copy" })];
  } }, set, 7);
  const report = buildReport(set, result, result, parseArgs([]), {});
  assert.equal(report.metrics.hybrid.fallbacks, 1);
  assert.equal(report.metrics.hybrid.fallbackUnknown, 0);
  assert.equal(report.perQuery[1].hybridFallback, true);
  assert.equal(report.perQuery[1].hybridFallbackReason, "storage_unavailable");
  assert.ok(!JSON.stringify(report).includes("do-not-copy"));
});

test("fixture validator accepts shipped fixture and every optional schema field", async () => {
  const fixture = loadQuerySet(await readFile(path.join(fixtureDir, "hybrid-shadow-queries.json"), "utf8"));
  assert.ok(fixture.queries.length > 0);
  const valid = { ...querySet(), $schema: "schema.json", description: "description",
    queries: [{ ...one, docHint: "hint", note: "note" }] };
  assert.deepEqual(loadQuerySet(JSON.stringify(valid)), valid);
  for (const query of ["abc", "a".repeat(200), "😀".repeat(200)]) {
    assert.doesNotThrow(() => loadQuerySet(JSON.stringify(querySet([{ ...one, query }]))));
  }
  assert.doesNotThrow(() => loadQuerySet(JSON.stringify({ version: 1, queries: [{ ...one, relevance: {} }] })));
});

test("fixture validator rejects malformed envelopes, entries, grades, keys and duplicate IDs", () => {
  const bad: unknown[] = [null, [], 1, "string", {}, { version: 2, queries: [one] },
    { version: 1, queries: [] }, { version: 1, queries: null }, { ...querySet(), extra: true },
    { ...querySet(), $schema: 1 }, { ...querySet(), description: [] }];
  for (const entry of [null, [], {}, 7, { ...one, extra: "x" }, { ...one, id: 1 },
    { ...one, id: "x" }, { ...one, id: "-bad" }, { ...one, id: "Bad" },
    { ...one, query: null }, { ...one, query: [] }, { ...one, query: 42 },
    { ...one, query: "ab" }, { ...one, query: "😀".repeat(201) },
    { ...one, docHint: 3 }, { ...one, note: {} }, { ...one, relevance: null },
    { ...one, relevance: [] }, { ...one, relevance: "x" }, { ...one, relevance: { "bad slug": 1 } },
    ...[-1, 4, 1.5, "3", null, true, [], {}].map((grade) => ({ ...one, relevance: { slug: grade } }))]) {
    bad.push({ version: 1, queries: [entry] });
  }
  for (const value of bad) assert.throws(() => loadQuerySet(JSON.stringify(value)), /invalid query/, JSON.stringify(value));
  assert.throws(() => loadQuerySet(JSON.stringify(querySet([one, one]))), /duplicate query id/);
  assert.throws(() => loadQuerySet("{bad json"), SyntaxError);
});

test("explicit runtime validator stays in parity with the schema constraints", async () => {
  // Pin validation keywords, not descriptive annotations. Any schema contract
  // change requires updating the explicit validator and boundary cases above.
  const schema = JSON.parse(await readFile(path.join(fixtureDir, "hybrid-shadow-queries.schema.json"), "utf8"));
  const stripAnnotations = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stripAnnotations);
    if (value !== null && typeof value === "object") return Object.fromEntries(
      Object.entries(value).filter(([key, val]) => !(["$schema", "$id", "title", "description"].includes(key) && typeof val === "string"))
        .map(([key, val]) => [key, stripAnnotations(val)]));
    return value;
  };
  assert.deepEqual(stripAnnotations(schema), {
    type: "object", required: ["version", "queries"], additionalProperties: false,
    properties: {
      version: { type: "integer", const: 1 }, $schema: { type: "string" }, description: { type: "string" },
      queries: { type: "array", minItems: 1, items: {
        type: "object", required: ["id", "query", "relevance"], additionalProperties: false,
        properties: {
          id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*[a-z0-9]$" },
          query: { type: "string", minLength: 3, maxLength: 200 }, docHint: { type: "string" }, note: { type: "string" },
          relevance: { type: "object", propertyNames: { pattern: "^[a-z0-9][a-z0-9-]*$" },
            additionalProperties: { type: "integer", minimum: 0, maximum: 3 } },
        },
      } },
    },
  });
});

test("argument validation guards missing values and finite supported bounds", () => {
  for (const flag of ["--limit", "--k", "--out", "--scopes"]) {
    for (const args of [[flag], [flag, "--k", "1"], [flag, " "]]) assert.throws(() => parseArgs(args), /missing value/);
  }
  for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "201", "9007199254740992"]) {
    assert.throws(() => parseArgs(["--limit", value]));
  }
  for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "11"]) assert.throws(() => parseArgs(["--k", value]));
  assert.throws(() => parseArgs(["--unknown"]), /unknown argument/);
  assert.throws(() => parseArgs(["--scopes", "published"]), /admin or unscoped/);
  assert.deepEqual(parseArgs(["--limit", "200", "--k", "200", "--out", "reports", "--scopes", "admin"]),
    { limit: 200, k: 200, outDir: "reports", scopes: ["*"] });
  assert.equal(parseArgs(["--scopes", "unscoped"]).scopes, undefined);
});

test("rapid report writes preserve aggregate JSON, JSONL and honest secret-free metadata", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "shadow-eval-test-"));
  try {
    const set = querySet();
    const hybrid = await rankings(set, [[]]);
    const keyword = await rankings(set, [[]], "keyword");
    const opts = parseArgs([]);
    const report = buildReport(set, keyword, hybrid, opts, {
      REDIS_URL: "redis://secret-user:secret-password@private-host:6379",
      DATABASE_URL: "postgres://secret-database", NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64: "secret-hmac",
      NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64: "secret-provider",
    });
    const runs = await Promise.all(Array.from({ length: 8 }, () => writeReport(report, dir)));
    assert.equal((await readdir(dir)).length, runs.length * 3);
    assert.equal(new Set(runs.flatMap(Object.values)).size, runs.length * 3);
    for (const files of runs) {
      assert.deepEqual(JSON.parse(await readFile(files.aggregatePath, "utf8")), report);
      assert.deepEqual((await readFile(files.jsonl, "utf8")).trim().split("\n").map((line) => JSON.parse(line)), report.perQuery);
      const md = await readFile(files.summaryPath, "utf8");
      for (const text of Object.values(report.observation)) assert.ok(md.includes(text));
      assert.match(md, /unknown fallback/);
      assert.match(md, /MRR@10/);
      for (const file of Object.values(files)) {
        assert.doesNotMatch(await readFile(file, "utf8"), /secret-|private-host|published-only/);
        if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o077, 0);
      }
    }
    assert.equal(report.observation.redis, "configured");
    assert.equal(buildReport(set, keyword, hybrid, opts, {}).observation.redis, "not configured");
    assert.match(report.observation.scope, /unrestricted articles, all statuses/);
    assert.match(buildReport(set, keyword, hybrid, parseArgs(["--scopes", "admin"]), {}).observation.scope, /all scopes, all statuses/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("pure import has no provider/Prisma initialization; CLI rejects arguments before runtime setup", () => {
  const script = path.resolve(import.meta.dirname, "hybrid-shadow-eval.ts");
  const env = { ...process.env, DATABASE_URL: "", NOOSPHERE_HYBRID_QUERY_PROFILE_ID: "" };
  const imported = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `await import(${JSON.stringify(script)})`], { env, encoding: "utf8", timeout: 10000 });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, "");
  assert.equal(imported.stderr, "");
  const cli = spawnSync(process.execPath, ["--import", "tsx", script, "--out"], { env, encoding: "utf8", timeout: 10000 });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /missing value for --out/);
  assert.doesNotMatch(cli.stderr, /requires DATABASE_URL|Prisma/);
});
