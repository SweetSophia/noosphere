/**
 * Hybrid retrieval shadow evaluation harness (issue #319).
 *
 * Runs the SAME production search path (createNoosphereProvider.search) twice
 * per query — once with hybrid retrieval enabled, once keyword-only — against
 * the live database, without serving either result set. Persists per-query
 * rankings, computes recall@k / nDCG@k / MRR against the graded query set in
 * src/__tests__/fixtures/hybrid-shadow-queries.json, and writes a JSONL report
 * plus a Markdown summary.
 *
 * Read-only: never mutates articles, embeddings, or cache rows. The keyword
 * run may populate the lexical search cache; that is normal read-path
 * behavior and is not a mutation of source-of-truth data.
 *
 * Usage (host, keyword-only — hybrid path cannot reach host.docker.internal):
 *   npm run hybrid-shadow-eval [-- --limit 5 --k 5 --out <dir>]
 *
 * Full dual-path run: must execute inside the compose network so the pinned
 * provider endpoint (host.docker.internal:8741) resolves, with the app-role
 * DATABASE_URL pointing at db:5432:
 *   docker run --rm --network noosphere-net \
 *     --add-host host.docker.internal:host-gateway \
 *     -v "$PWD":/app -w /app \
 *     -e DATABASE_URL -e NOOSPHERE_HYBRID_QUERY_PROFILE_ID \
 *     -e NOOSPHERE_HYBRID_CACHE_HMAC_ACTIVE_VERSION \
 *     -e NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64 \
 *     -e NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64 \
 *     node:22-bookworm-slim npx tsx scripts/hybrid-shadow-eval.ts --out hybrid-shadow-reports
 *
 * Environment (from .env / shell):
 *   DATABASE_URL                        app-role connection (read path)
 *   NOOSPHERE_HYBRID_QUERY_PROFILE_ID   serving profile
 *   NOOSPHERE_HYBRID_CACHE_HMAC_ACTIVE_VERSION / _KEYS_B64   keyring
 *
 * Hybrid config is injected via the provider `environment` override — the
 * process env flag itself is never flipped.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import { createNoosphereProvider } from "@/lib/memory/noosphere";
import type { MemoryResult } from "@/lib/memory/types";

interface GradedQuery {
  id: string;
  query: string;
  relevance: Record<string, number>;
}

interface QuerySet {
  version: number;
  queries: GradedQuery[];
}

interface Ranking {
  path: "hybrid" | "keyword";
  queryId: string;
  query: string;
  results: Array<{ slug: string; title: string; score: number; grade?: number }>;
  latencyMs: number;
  hybridFallback?: boolean;
  hybridFallbackReason?: string;
}

const RELEVANCE_TIERS = [3, 2, 1] as const;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`shadow eval requires ${name}`);
  return value;
}

function parseArgs(argv: string[]): { limit: number; k: number; outDir: string; scopes: string[] | undefined } {
  const opts = { limit: 10, k: 5, outDir: "hybrid-shadow-reports", scopes: undefined as string[] | undefined };
  for (let i = 0; i < argv.length; i += 1) {
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
  if (!Number.isInteger(opts.limit) || opts.limit < 1) throw new Error("--limit must be a positive integer");
  if (!Number.isInteger(opts.k) || opts.k < 1 || opts.k > opts.limit) throw new Error("--k must be 1..limit");
  return opts;
}

function loadQuerySet(file: string): QuerySet {
  const raw = JSON.parse(file) as QuerySet;
  if (raw.version !== 1) throw new Error(`unsupported query set version ${raw.version}`);
  if (!Array.isArray(raw.queries) || raw.queries.length === 0) throw new Error("query set is empty");
  for (const q of raw.queries) {
    if (!q.id || !q.query || typeof q.relevance !== "object") {
      throw new Error(`malformed query entry: ${JSON.stringify(q).slice(0, 120)}`);
    }
  }
  return raw;
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

function reciprocalRank(grades: number[]): number | null {
  const first = grades.findIndex((g) => g > 0);
  return first === -1 ? null : 1 / (first + 1);
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
    hybridFallback: ranking.hybridFallback ?? false,
    hybridFallbackReason: ranking.hybridFallbackReason ?? null,
    results: ranking.results.map((r) => ({ slug: r.slug, title: r.title, score: r.score, grade: r.grade ?? null })),
  };
}

async function runPath(
  path: "hybrid" | "keyword",
  provider: ReturnType<typeof createNoosphereProvider>,
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
      hybridFallback: Boolean(meta0.hybridFallback),
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

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const fixturePath = path.resolve(import.meta.dirname, "../src/__tests__/fixtures/hybrid-shadow-queries.json");
  const querySet = loadQuerySet(await import("node:fs").then((fs) => fs.readFileSync(fixturePath, "utf8")));

  const databaseUrl = requireEnv("DATABASE_URL");
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  const baseEnv: Record<string, string | undefined> = {
    ...process.env,
    NOOSPHERE_HYBRID_QUERY_PROFILE_ID: requireEnv("NOOSPHERE_HYBRID_QUERY_PROFILE_ID"),
    NOOSPHERE_HYBRID_CACHE_HMAC_ACTIVE_VERSION: requireEnv("NOOSPHERE_HYBRID_CACHE_HMAC_ACTIVE_VERSION"),
    NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64: requireEnv("NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64"),
  };

  const hybridProvider = createNoosphereProvider({
    prisma,
    allowedScopes: opts.scopes,
    environment: { ...baseEnv, NOOSPHERE_HYBRID_RETRIEVAL_ENABLED: "true" },
  });
  const keywordProvider = createNoosphereProvider({
    prisma,
    allowedScopes: opts.scopes,
    environment: { ...baseEnv, NOOSPHERE_HYBRID_RETRIEVAL_ENABLED: "false" },
  });

  process.stdout.write(`shadow eval: ${querySet.queries.length} queries, limit ${opts.limit}, k ${opts.k}, scopes ${opts.scopes ? opts.scopes.join(",") : "unscoped (published-only)"}\n`);
  const keywordRankings = await runPath("keyword", keywordProvider, querySet, opts.limit);
  const hybridRankings = await runPath("hybrid", hybridProvider, querySet, opts.limit);

  const metrics: Record<string, { path: string; recall: number | null; ndcg: number | null; mrr: number | null; latencyP50: number; fallbacks: number }> = {};
  for (const [path, rankings] of [["keyword", keywordRankings], ["hybrid", hybridRankings]] as const) {
    let recallSum = 0, recallN = 0, ndcgSum = 0, ndcgN = 0, mrrSum = 0, mrrN = 0, fallbacks = 0;
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
      if (rr !== null) { mrrSum += rr; mrrN += 1; }
      latencies.push(ranking.latencyMs);
      if (ranking.hybridFallback) fallbacks += 1;
    }
    latencies.sort((a, b) => a - b);
    metrics[path] = {
      path,
      recall: recallN ? recallSum / recallN : null,
      ndcg: ndcgN ? ndcgSum / ndcgN : null,
      mrr: mrrN ? mrrSum / mrrN : null,
      latencyP50: latencies[Math.floor(latencies.length / 2)] ?? 0,
      fallbacks,
    };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    querySetVersion: querySet.version,
    queryCount: querySet.queries.length,
    limit: opts.limit,
    k: opts.k,
    relevanceTiers: RELEVANCE_TIERS,
    metrics,
    perQuery: [...keywordRankings, ...hybridRankings].map(toReportEntry),
  };

  await mkdir(opts.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 17);
  const jsonl = path.join(opts.outDir, `shadow-${stamp}.jsonl`);
  await writeFile(jsonl, [...keywordRankings, ...hybridRankings].map((r) => JSON.stringify(toReportEntry(r))).join("\n") + "\n");
  const summaryPath = path.join(opts.outDir, `shadow-${stamp}.md`);
  const md: string[] = [
    `# Hybrid shadow evaluation — ${report.generatedAt}`,
    ``,
    `Query set v${querySet.version} (${querySet.queries.length} queries), limit ${opts.limit}, k ${opts.k}. Keyword path ran first; hybrid results were computed but never served.`,
    ``,
    `| path | recall@${opts.k} | nDCG@${opts.k} | MRR | p50 latency (ms) | fallbacks |`,
    `| --- | --- | --- | --- | --- | --- |`,
  ];
  for (const p of ["keyword", "hybrid"]) {
    const m = metrics[p];
    md.push(`| ${p} | ${m.recall?.toFixed(3) ?? "n/a"} | ${m.ndcg?.toFixed(3) ?? "n/a"} | ${m.mrr?.toFixed(3) ?? "n/a"} | ${m.latencyP50} | ${m.fallbacks} |`);
  }
  md.push(``, `Full per-query rankings: \`${path.basename(jsonl)}\``);
  await writeFile(summaryPath, md.join("\n") + "\n");
  process.stdout.write(`\nreport: ${jsonl}\nsummary: ${summaryPath}\n`);
  await prisma.$disconnect();
  await pool.end();
}

main().catch((error) => {
  console.error("[shadow-eval] fatal:", error);
  process.exit(1);
});
