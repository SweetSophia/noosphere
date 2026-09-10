/**
 * Hybrid retrieval shadow evaluation harness (issue #319).
 *
 * Runs the SAME production search path (createNoosphereProvider.search) twice
 * per query — once with hybrid retrieval enabled, once keyword-only — against
 * the live database, without serving either result set. Persists per-query
 * rankings, computes recall@k / nDCG@k / MRR against the graded query set in
 * src/__tests__/fixtures/hybrid-shadow-queries.json, and writes a JSONL report
 * plus aggregate JSON and a Markdown summary.
 *
 * Not side-effect-free: production reads can populate lexical/hybrid caches,
 * authorize query dispatch in the database, and call the embedding endpoint.
 * Keyword runs first and may warm the lexical cache used by hybrid fallback.
 * No article edits or corpus-vector writes are requested by this harness.
 * Reports can contain restricted article titles; keep them private.
 *
 * Usage (dual-path evaluation by default; --preflight-only performs only the
 * freshness lookup and writes no metric reports — see docs/HYBRID-SHADOW-EVALUATION.md):
 *   npm run hybrid:shadow-eval -- --limit 5 --k 5 --query-ids <id,id,...> --out <dir>
 *   npm run hybrid:shadow-eval -- --limit 5 --k 5 --all-queries --out <dir>
 *   npm run hybrid:shadow-eval -- --preflight-only --out <dir>
 *
 * Full dual-path run: must execute inside the compose network so the pinned
 * provider endpoint (host.docker.internal:8741) resolves, with the app-role
 * DATABASE_URL pointing at db:5432:
 *   docker run --rm --network noosphere-net \
 *     --add-host host.docker.internal:host-gateway \
 *     -v "$PWD":/app -w /app \
 *     -e DATABASE_URL -e REDIS_URL -e NOOSPHERE_HYBRID_QUERY_PROFILE_ID \
 *     -e NOOSPHERE_HYBRID_CACHE_HMAC_ACTIVE_VERSION \
 *     -e NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64 \
 *     -e NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64 \
 *     node:22-bookworm-slim npx tsx scripts/hybrid-shadow-eval.ts --query-ids release-1-13-2,pgvector-production,pr-merge-verification,openclaw-recovery,pixel-agents-prs,paraphrase-embedding-search,paraphrase-auth-repair,mismatch-data-safety,cross-release-evidence,noanswer-cooking-recipe --out hybrid-shadow-reports
 *
 * Environment (from .env / shell):
 *   DATABASE_URL                        app-role connection (read path)
 *   REDIS_URL                           optional; omitted means no Redis cache
 *   NOOSPHERE_HYBRID_QUERY_PROFILE_ID   serving profile
 *   NOOSPHERE_HYBRID_CACHE_HMAC_ACTIVE_VERSION / _KEYS_B64   keyring
 *
 * Hybrid config is injected via the provider `environment` override — the
 * process env flag itself is never flipped.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { MemoryProvider } from "@/lib/memory/provider";
import type { MemoryResult } from "@/lib/memory/types";
import { HYBRID_MAX_WINDOW } from "@/lib/memory/hybrid-ranking";
import { checkFixtureFreshness, type FixtureFreshness } from "./hybrid-shadow-freshness";

interface GradedQuery {
  id: string;
  query: string;
  relevance: Record<string, number>;
}

export interface QuerySet {
  version: number;
  queries: GradedQuery[];
}

export interface Ranking {
  path: "hybrid" | "keyword";
  queryId: string;
  query: string;
  results: Array<{ slug: string; title: string; score: number; grade?: number }>;
  latencyMs: number;
  hybridFallback: boolean | null;
  hybridFallbackReason?: string;
}

const RELEVANCE_TIERS = [3, 2, 1] as const;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`shadow eval requires ${name}`);
  return value;
}

export function parseArgs(argv: string[]): { limit: number; k: number; outDir: string; scopes: string[] | undefined; queryIds?: string[]; allQueries?: boolean; preflightOnly?: boolean; freshnessAdmin?: boolean } {
  const opts: ReturnType<typeof parseArgs> = { limit: 10, k: 5, outDir: "hybrid-shadow-reports", scopes: undefined as string[] | undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--preflight-only") { opts.preflightOnly = true; continue; }
    if (argv[i] === "--freshness-admin") { opts.freshnessAdmin = true; continue; }
    if (argv[i] === "--all-queries") { opts.allQueries = true; continue; }
    if (!["--limit", "--k", "--out", "--scopes", "--query-ids"].includes(argv[i])) throw new Error(`unknown argument: ${argv[i]}`);
    if (!argv[i + 1]?.trim() || argv[i + 1].startsWith("--")) throw new Error(`missing value for ${argv[i]}`);
    if (argv[i] === "--limit") opts.limit = Number(argv[++i]);
    else if (argv[i] === "--k") opts.k = Number(argv[++i]);
    else if (argv[i] === "--out") opts.outDir = String(argv[++i]);
    else if (argv[i] === "--scopes") {
      const value = String(argv[++i]);
      if (value === "admin") opts.scopes = ["*"];
      else if (value === "unscoped") opts.scopes = undefined;
      else throw new Error(`--scopes must be admin or unscoped (got: ${value})`);
    }
    else if (argv[i] === "--query-ids") {
      const ids = String(argv[++i]).split(",").map((id) => id.trim());
      if (ids.some((id) => !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(id)) || new Set(ids).size !== ids.length) {
        throw new Error("--query-ids must be a comma-separated list of unique query IDs");
      }
      opts.queryIds = ids;
    }
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!Number.isSafeInteger(opts.limit) || opts.limit < 1 || opts.limit > HYBRID_MAX_WINDOW) throw new Error(`--limit must be 1..${HYBRID_MAX_WINDOW}`);
  if (!Number.isInteger(opts.k) || opts.k < 1 || opts.k > opts.limit) throw new Error("--k must be 1..limit");
  if (opts.queryIds && opts.allQueries) throw new Error("--query-ids and --all-queries are mutually exclusive");
  return opts;
}

export function selectQueries(querySet: QuerySet, queryIds: string[] | undefined, allowAll = false): QuerySet {
  if (!queryIds) {
    if (!allowAll) throw new Error("score-bearing run requires --query-ids or explicit --all-queries");
    return querySet;
  }
  const selected = new Set(queryIds);
  const queries = querySet.queries.filter((query) => selected.has(query.id));
  if (queries.length !== selected.size) {
    const known = new Set(querySet.queries.map((query) => query.id));
    throw new Error(`unknown query id: ${queryIds.find((id) => !known.has(id))}`);
  }
  return { ...querySet, queries };
}

export function loadQuerySet(file: string): QuerySet {
  const raw: unknown = JSON.parse(file);
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const keys = (value: Record<string, unknown>, allowed: string[]) =>
    Object.keys(value).every((key) => allowed.includes(key));
  const optionalStrings = (value: Record<string, unknown>, names: string[]) =>
    names.every((name) => !(name in value) || typeof value[name] === "string");
  // Explicit equivalent of hybrid-shadow-queries.schema.json; parity is tested.
  if (!object(raw) || !keys(raw, ["version", "queries", "$schema", "description"]) ||
      raw.version !== 1 || !optionalStrings(raw, ["$schema", "description"]) ||
      !Array.isArray(raw.queries) || raw.queries.length === 0) {
    throw new Error("invalid query set envelope");
  }
  const ids = new Set<string>();
  for (const q of raw.queries) {
    if (!object(q) || !keys(q, ["id", "query", "relevance", "docHint", "note"]) ||
        typeof q.id !== "string" || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(q.id) ||
        typeof q.query !== "string" || [...q.query].length < 3 || [...q.query].length > 200 ||
        !optionalStrings(q, ["docHint", "note"]) || !object(q.relevance) ||
        !Object.entries(q.relevance).every(([slug, grade]) =>
          /^[a-z0-9][a-z0-9-]*$/.test(slug) && typeof grade === "number" &&
          Number.isInteger(grade) && grade >= 0 && grade <= 3)) {
      throw new Error("invalid query entry");
    }
    if (ids.has(q.id)) throw new Error(`duplicate query id: ${q.id}`);
    ids.add(q.id);
  }
  return raw as unknown as QuerySet;
}

function dcgAtK(grades: number[], k: number): number {
  return grades.slice(0, k).reduce((sum, grade, i) => sum + (grade > 0 ? grade / Math.log2(i + 2) : 0), 0);
}

function idealDcgAtK(allGrades: number[], k: number): number {
  const sorted = [...allGrades].sort((a, b) => b - a);
  return dcgAtK(sorted, k);
}

function recallAtK(grades: number[], relevantTotal: number, k: number): number | null {
  if (relevantTotal === 0) return null;
  return grades.slice(0, k).filter((g) => g > 0).length / relevantTotal;
}

function reciprocalRank(grades: number[]): number {
  const first = grades.findIndex((g) => g > 0);
  return first === -1 ? 0 : 1 / (first + 1);
}

function slugOf(result: MemoryResult): string | undefined {
  const metadata = result.metadata as Record<string, unknown> | undefined;
  const slug = metadata?.articleSlug;
  return typeof slug === "string" ? slug : undefined;
}

function toReportEntry(ranking: Ranking): Record<string, unknown> {
  return {
    path: ranking.path,
    queryId: ranking.queryId,
    query: ranking.query,
    latencyMs: ranking.latencyMs,
    hybridFallback: ranking.hybridFallback,
    hybridFallbackReason: ranking.hybridFallbackReason ?? null,
    results: ranking.results.map((r) => ({ slug: r.slug, title: r.title, score: r.score, grade: r.grade ?? null })),
  };
}

export async function runPath(
  path: "hybrid" | "keyword",
  provider: Pick<MemoryProvider, "search">,
  querySet: QuerySet,
  limit: number,
): Promise<Ranking[]> {
  const rankings: Ranking[] = [];
  for (const graded of querySet.queries) {
    const started = performance.now();
    const results = await provider.search(graded.query, { limit });
    const latencyMs = Math.round(performance.now() - started);
    const meta0 = (results[0]?.metadata ?? {}) as Record<string, unknown>;
    const judgedSlugs = new Set<string>();
    rankings.push({
      path,
      queryId: graded.id,
      query: graded.query,
      latencyMs,
      // The provider annotates returned rows only: an empty hybrid result
      // cannot distinguish successful retrieval from an empty lexical fallback.
      hybridFallback: path === "keyword" ? false : results.length === 0 ? null : Boolean(meta0.hybridFallback),
      hybridFallbackReason: typeof meta0.hybridFallbackReason === "string" ? meta0.hybridFallbackReason : undefined,
      results: results.map((r) => {
        const slug = slugOf(r);
        // Fixture judgments are per slug, but slugs are only unique per topic.
        // Credit a slug once, preserving duplicate rows and their rank positions.
        const grade = slug !== undefined && !judgedSlugs.has(slug) ? graded.relevance[slug] ?? 0 : 0;
        if (slug !== undefined) judgedSlugs.add(slug);
        return { slug: slug ?? "unknown", title: r.title ?? slug ?? "unknown", score: r.relevanceScore ?? 0, grade };
      }),
    });
    process.stdout.write(`  [${path}] ${graded.id}: ${results.length} results, ${latencyMs} ms${meta0.hybridFallback ? ` (fallback: ${String(meta0.hybridFallbackReason)})` : ""}\n`);
  }
  return rankings;
}

export function buildReport(
  querySet: QuerySet,
  keywordRankings: Ranking[],
  hybridRankings: Ranking[],
  opts: ReturnType<typeof parseArgs>,
  environment: Readonly<Record<string, string | undefined>>,
  freshness: FixtureFreshness | null = null,
) {
  const metrics: Record<string, { path: string; recall: number | null; ndcg: number | null; mrr: number | null; latencyP50: number; fallbacks: number; fallbackUnknown: number; denominators: { recall: { evaluated: number; excluded: number }; ndcg: { evaluated: number; excluded: number }; mrr: { evaluated: number; excluded: number } } }> = {};
  for (const [path, rankings] of [["keyword", keywordRankings], ["hybrid", hybridRankings]] as const) {
    let recallSum = 0, recallN = 0, ndcgSum = 0, ndcgN = 0, mrrSum = 0, fallbacks = 0, fallbackUnknown = 0;
    const latencies: number[] = [];
    for (const ranking of rankings) {
      const graded = querySet.queries.find((q) => q.id === ranking.queryId)!;
      const grades = ranking.results.map((r) => r.grade ?? 0);
      const relevantTotal = Object.values(graded.relevance).filter((g) => g > 0).length;
      const recall = recallAtK(grades, relevantTotal, opts.k);
      if (recall !== null) { recallSum += recall; recallN += 1; }
      const ideal = idealDcgAtK(Object.values(graded.relevance), opts.k);
      if (ideal > 0) { ndcgSum += dcgAtK(grades, opts.k) / ideal; ndcgN += 1; }
      const rr = reciprocalRank(grades);
      mrrSum += rr;
      latencies.push(ranking.latencyMs);
      if (ranking.hybridFallback) fallbacks += 1;
      if (ranking.hybridFallback === null) fallbackUnknown += 1;
    }
    latencies.sort((a, b) => a - b);
    metrics[path] = {
      path,
      recall: recallN ? recallSum / recallN : null,
      ndcg: ndcgN ? ndcgSum / ndcgN : null,
      mrr: rankings.length ? mrrSum / rankings.length : null,
      latencyP50: latencies[Math.floor(latencies.length / 2)] ?? 0,
      fallbacks,
      fallbackUnknown,
      denominators: {
        recall: { evaluated: recallN, excluded: rankings.length - recallN },
        ndcg: { evaluated: ndcgN, excluded: rankings.length - ndcgN },
        mrr: { evaluated: rankings.length, excluded: 0 },
      },
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    querySetVersion: querySet.version,
    queryCount: querySet.queries.length,
    queryIds: querySet.queries.map((query) => query.id),
    limit: opts.limit,
    k: opts.k,
    relevanceTiers: RELEVANCE_TIERS,
    freshness,
    observation: {
      scope: opts.scopes?.includes("*") ? "admin (all scopes, all statuses)" : "unscoped (unrestricted articles, all statuses)",
      redis: environment.REDIS_URL ? "configured" : "not configured",
      redisLimitation: "Configuration only; Redis health and cache hits are not measured.",
      order: "Keyword path ran first; it may warm the lexical cache used by hybrid fallback. Latencies are not a cold-cache comparison.",
      sideEffects: "Production searches may write lexical/hybrid caches, authorize query dispatch in the database, and call the embedding endpoint. No article edits or corpus-vector writes are requested; results are not served.",
      fallback: "Fallback is observed from returned-row metadata only. Empty hybrid results have unknown fallback (null), counted separately, not assumed successful.",
      metrics: `Recall@${opts.k} treats grades > 0 as relevant; nDCG@${opts.k} uses linear gain (grade/log2(rank+1)) and IDCG from the scored query's complete fixture judgments. Judgments are per slug: only its first occurrence earns credit; duplicates retain their rank with grade 0. Recall/nDCG exclude queries with no positive judgments. MRR@${opts.limit} uses all selected queries with misses = 0 and the returned limit, not k.`,
    },
    metrics,
    perQuery: [...keywordRankings, ...hybridRankings].map(toReportEntry),
  };
}

export async function writeReport(report: ReturnType<typeof buildReport>, outDir: string) {
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const stamp = `${report.generatedAt.replace(/[:.]/g, "-")}-${randomUUID()}`;
  const jsonl = path.join(outDir, `shadow-${stamp}.jsonl`);
  const aggregatePath = path.join(outDir, `shadow-${stamp}.json`);
  const summaryPath = path.join(outDir, `shadow-${stamp}.md`);
  await writeFile(jsonl, report.perQuery.map((r) => JSON.stringify(r)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
  await writeFile(aggregatePath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const md: string[] = [
    `# Hybrid shadow evaluation — ${report.generatedAt}`,
    ``,
    `Query set v${report.querySetVersion} (${report.queryCount} queries), limit ${report.limit}, k ${report.k}.`,
    ``,
    `Scope: ${report.observation.scope}. Redis: ${report.observation.redis}. ${report.observation.redisLimitation}`,
    ...[report.observation.order, report.observation.sideEffects, report.observation.fallback, report.observation.metrics].flatMap((text) => ["", text]),
    ``,
    `| path | recall@${report.k} | nDCG@${report.k} | MRR@${report.limit} | p50 latency (ms) | observed fallbacks | unknown fallback |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
  ];
  for (const p of ["keyword", "hybrid"]) {
    const m = report.metrics[p];
    md.push(`| ${p} | ${m.recall?.toFixed(3) ?? "n/a"} | ${m.ndcg?.toFixed(3) ?? "n/a"} | ${m.mrr?.toFixed(3) ?? "n/a"} | ${m.latencyP50} | ${m.fallbacks} | ${m.fallbackUnknown} |`);
  }
  md.push("", "| path | recall evaluated | recall excluded | nDCG evaluated | nDCG excluded | MRR all-query denominator | MRR excluded |",
    "| --- | --- | --- | --- | --- | --- | --- |");
  for (const p of ["keyword", "hybrid"]) {
    const d = report.metrics[p].denominators;
    md.push(`| ${p} | ${d.recall.evaluated} | ${d.recall.excluded} | ${d.ndcg.evaluated} | ${d.ndcg.excluded} | ${d.mrr.evaluated} | ${d.mrr.excluded} |`);
  }
  md.push("", "## Fixture freshness");
  if (report.freshness) {
    const f = report.freshness;
    md.push("", `Evaluation scope: ${f.evaluationScope}; evidence scope: ${f.evidenceScope}.`,
      `Started: ${f.startedAt}; checked: ${f.checkedAt}; outcome: ${f.outcome}.`, "", f.limitation,
      "", ...Object.entries(f.counts).map(([status, count]) => `- ${status}: ${count}`),
      "", "Per-judgment outcomes are in the private aggregate JSON.");
  } else md.push("", "Not checked; not decision-grade evidence.");
  md.push(``, `Full per-query rankings: \`${path.basename(jsonl)}\``);
  md.push(`Aggregate report: \`${path.basename(aggregatePath)}\``);
  await writeFile(summaryPath, md.join("\n") + "\n", { flag: "wx", mode: 0o600 });
  return { jsonl, aggregatePath, summaryPath };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const fixturePath = path.resolve(import.meta.dirname, "../src/__tests__/fixtures/hybrid-shadow-queries.json");
  const querySet = selectQueries(loadQuerySet(await readFile(fixturePath, "utf8")), opts.queryIds, Boolean(opts.preflightOnly || opts.allQueries));
  const databaseUrl = requireEnv("DATABASE_URL");
  const baseEnv = opts.preflightOnly ? process.env : {
    ...process.env,
    NOOSPHERE_HYBRID_QUERY_PROFILE_ID: requireEnv("NOOSPHERE_HYBRID_QUERY_PROFILE_ID"),
    NOOSPHERE_HYBRID_CACHE_HMAC_ACTIVE_VERSION: requireEnv("NOOSPHERE_HYBRID_CACHE_HMAC_ACTIVE_VERSION"),
    NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64: requireEnv("NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64"),
  };
  // Preflight-only never imports Prisma, Redis, or the search provider.
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const freshness = await checkFixtureFreshness(pool, querySet, opts.scopes, opts.freshnessAdmin);
    // Persist preflight even if later retrieval fails. No search/cache/embedding
    // work is requested by preflight-only. Do not treat it as a metric report.
    await mkdir(opts.outDir, { recursive: true, mode: 0o700 });
    const freshnessPath = path.join(opts.outDir, `freshness-${randomUUID()}.json`);
    await writeFile(freshnessPath, JSON.stringify({ querySetVersion: querySet.version, freshness }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    process.stdout.write(`freshness: ${freshness.outcome}; evidence: ${freshnessPath}\n`);
    if (opts.preflightOnly) return;
    const [{ PrismaClient }, { PrismaPg }, { createNoosphereProvider }, { closeRedisClient }] = await Promise.all([
      import("@prisma/client"), import("@prisma/adapter-pg"),
      import("@/lib/memory/noosphere"), import("@/lib/cache/redis"),
    ]);
    const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    try {
      const keywordProvider = createNoosphereProvider({ prisma, allowedScopes: opts.scopes,
        environment: { ...baseEnv, NOOSPHERE_HYBRID_RETRIEVAL_ENABLED: "false" } });
      const hybridProvider = createNoosphereProvider({ prisma, allowedScopes: opts.scopes,
        environment: { ...baseEnv, NOOSPHERE_HYBRID_RETRIEVAL_ENABLED: "true" } });
      process.stdout.write(`shadow eval: ${querySet.queries.length} queries, limit ${opts.limit}, k ${opts.k}, scopes ${opts.scopes ? "admin (all scopes, all statuses)" : "unscoped (unrestricted articles, all statuses)"}\n`);
      const keywordRankings = await runPath("keyword", keywordProvider, querySet, opts.limit);
      const hybridRankings = await runPath("hybrid", hybridProvider, querySet, opts.limit);
      const files = await writeReport(buildReport(querySet, keywordRankings, hybridRankings, opts, baseEnv, freshness), opts.outDir);
      process.stdout.write(`\nreport: ${files.jsonl}\naggregate: ${files.aggregatePath}\nsummary: ${files.summaryPath}\n`);
    } finally {
      try { await prisma.$disconnect(); } finally { await closeRedisClient(); }
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error("[shadow-eval] fatal:", error);
    process.exitCode = 1;
  });
}
