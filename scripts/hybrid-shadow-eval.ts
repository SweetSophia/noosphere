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
 * Usage (always dual-path; unreachable hybrid services may cause fallback):
 *   npm run hybrid:shadow-eval -- --limit 5 --k 5 --out <dir>
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
 *     node:22-bookworm-slim npx tsx scripts/hybrid-shadow-eval.ts --out hybrid-shadow-reports
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

export function parseArgs(argv: string[]): { limit: number; k: number; outDir: string; scopes: string[] | undefined } {
  const opts = { limit: 10, k: 5, outDir: "hybrid-shadow-reports", scopes: undefined as string[] | undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (!["--limit", "--k", "--out", "--scopes"].includes(argv[i])) throw new Error(`unknown argument: ${argv[i]}`);
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
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!Number.isSafeInteger(opts.limit) || opts.limit < 1 || opts.limit > HYBRID_MAX_WINDOW) throw new Error(`--limit must be 1..${HYBRID_MAX_WINDOW}`);
  if (!Number.isInteger(opts.k) || opts.k < 1 || opts.k > opts.limit) throw new Error("--k must be 1..limit");
  return opts;
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
        const slug = slugOf(r) ?? "unknown";
        return { slug, title: r.title ?? slug, score: r.relevanceScore ?? 0, grade: graded.relevance[slug] ?? 0 };
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
) {
  const metrics: Record<string, { path: string; recall: number | null; ndcg: number | null; mrr: number | null; latencyP50: number; fallbacks: number; fallbackUnknown: number }> = {};
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
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    querySetVersion: querySet.version,
    queryCount: querySet.queries.length,
    limit: opts.limit,
    k: opts.k,
    relevanceTiers: RELEVANCE_TIERS,
    observation: {
      scope: opts.scopes?.includes("*") ? "admin (all scopes, all statuses)" : "unscoped (unrestricted articles, all statuses)",
      redis: environment.REDIS_URL ? "configured" : "not configured",
      redisLimitation: "Configuration only; Redis health and cache hits are not measured.",
      order: "Keyword path ran first; it may warm the lexical cache used by hybrid fallback. Latencies are not a cold-cache comparison.",
      sideEffects: "Production searches may write lexical/hybrid caches, authorize query dispatch in the database, and call the embedding endpoint. No article edits or corpus-vector writes are requested; results are not served.",
      fallback: "Fallback is observed from returned-row metadata only. Empty hybrid results have unknown fallback (null), counted separately, not assumed successful.",
      metrics: `Recall@${opts.k} treats grades > 0 as relevant; nDCG@${opts.k} uses linear gain (grade/log2(rank+1)) and IDCG from the full fixture. Recall/nDCG exclude queries with no positive judgments. MRR@${opts.limit} uses all queries with misses = 0 and the returned limit, not k.`,
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
  md.push(``, `Full per-query rankings: \`${path.basename(jsonl)}\``);
  md.push(`Aggregate report: \`${path.basename(aggregatePath)}\``);
  await writeFile(summaryPath, md.join("\n") + "\n", { flag: "wx", mode: 0o600 });
  return { jsonl, aggregatePath, summaryPath };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const fixturePath = path.resolve(import.meta.dirname, "../src/__tests__/fixtures/hybrid-shadow-queries.json");
  const querySet = loadQuerySet(await readFile(fixturePath, "utf8"));
  const databaseUrl = requireEnv("DATABASE_URL");
  const baseEnv = {
    ...process.env,
    NOOSPHERE_HYBRID_QUERY_PROFILE_ID: requireEnv("NOOSPHERE_HYBRID_QUERY_PROFILE_ID"),
    NOOSPHERE_HYBRID_CACHE_HMAC_ACTIVE_VERSION: requireEnv("NOOSPHERE_HYBRID_CACHE_HMAC_ACTIVE_VERSION"),
    NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64: requireEnv("NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64"),
  };
  // Pure imports above never initialize Prisma, Redis, or a provider.
  const [{ PrismaClient }, { PrismaPg }, { Pool }, { createNoosphereProvider }, { closeRedisClient }] = await Promise.all([
    import("@prisma/client"), import("@prisma/adapter-pg"), import("pg"),
    import("@/lib/memory/noosphere"), import("@/lib/cache/redis"),
  ]);
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    try {
      const keywordProvider = createNoosphereProvider({ prisma, allowedScopes: opts.scopes,
        environment: { ...baseEnv, NOOSPHERE_HYBRID_RETRIEVAL_ENABLED: "false" } });
      const hybridProvider = createNoosphereProvider({ prisma, allowedScopes: opts.scopes,
        environment: { ...baseEnv, NOOSPHERE_HYBRID_RETRIEVAL_ENABLED: "true" } });
      process.stdout.write(`shadow eval: ${querySet.queries.length} queries, limit ${opts.limit}, k ${opts.k}, scopes ${opts.scopes ? "admin (all scopes, all statuses)" : "unscoped (unrestricted articles, all statuses)"}\n`);
      const keywordRankings = await runPath("keyword", keywordProvider, querySet, opts.limit);
      const hybridRankings = await runPath("hybrid", hybridProvider, querySet, opts.limit);
      const files = await writeReport(buildReport(querySet, keywordRankings, hybridRankings, opts, baseEnv), opts.outDir);
      process.stdout.write(`\nreport: ${files.jsonl}\naggregate: ${files.aggregatePath}\nsummary: ${files.summaryPath}\n`);
    } finally {
      await prisma.$disconnect();
    }
  } finally {
    try { await pool.end(); } finally { await closeRedisClient(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error("[shadow-eval] fatal:", error);
    process.exitCode = 1;
  });
}
