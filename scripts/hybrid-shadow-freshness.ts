import type { Pool } from "pg";
import type { QuerySet } from "./hybrid-shadow-eval";

export type FreshnessStatus = "visible" | "excluded-by-scope" | "corpus-absent" | "unknown/not-visible" | "ambiguous";

/** Exact corpus lookup, never retrieval results. Only an explicitly authorized
 * admin inspection may distinguish hidden rows from absent rows. SQL filters
 * unauthorized rows before aggregation; no titles, tags, IDs or topics leave SQL.
 */
export async function checkFixtureFreshness(
  db: Pick<Pool, "query">,
  querySet: QuerySet,
  scopes: string[] | undefined,
  adminEvidence = false,
) {
  // Match the CLI's deliberately limited scope contract; do not silently
  // reinterpret named provider scopes as unrestricted-only visibility.
  if (scopes?.length && !(scopes.length === 1 && scopes[0] === "*")) {
    throw new Error("freshness supports only unscoped or admin ([\"*\"]) evaluation scopes");
  }
  const startedAt = new Date().toISOString();
  const evaluationAdmin = scopes?.includes("*") ?? false;
  const inspectAll = evaluationAdmin || adminEvidence;
  const slugs = [...new Set(querySet.queries.flatMap((q) => Object.keys(q.relevance)))];
  const { rows } = await db.query<{ slug: string; total: number; visible: number }>(`
    SELECT slug, count(*)::int AS total,
      count(*) FILTER (WHERE $2::boolean OR cardinality("restrictedTags") = 0)::int AS visible
    FROM "Article"
    WHERE slug = ANY($1::text[]) AND "deletedAt" IS NULL
      AND ($3::boolean OR cardinality("restrictedTags") = 0)
    GROUP BY slug
  `, [slugs, evaluationAdmin, inspectAll]);
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  const judgments = querySet.queries.flatMap((q) => Object.keys(q.relevance).map((slug) => {
    const row = bySlug.get(slug);
    const total = row?.total ?? 0;
    const visible = row?.visible ?? 0;
    const status: FreshnessStatus = total > 1 ? "ambiguous" : visible > 0 ? "visible"
      : !inspectAll ? "unknown/not-visible" : total > 0 ? "excluded-by-scope" : "corpus-absent";
    // Slug and queryId come from the fixture, not restricted corpus metadata.
    return { queryId: q.id, slug, status };
  }));
  const counts: Record<FreshnessStatus, number> = {
    visible: 0, "excluded-by-scope": 0, "corpus-absent": 0, "unknown/not-visible": 0, ambiguous: 0,
  };
  for (const judgment of judgments) counts[judgment.status] += 1;
  return {
    startedAt,
    checkedAt: new Date().toISOString(),
    evaluationScope: evaluationAdmin ? "admin" : "unscoped",
    evidenceScope: inspectAll ? "admin" : "unscoped",
    outcome: judgments.every((j) => j.status === "visible") ? "clear" : "needs-review",
    limitation: "Point-in-time check, not a serving acceptance decision. Soft-deleted rows are outside the corpus; all lifecycle statuses are included. Slug-only judgments can be ambiguous across topics. Unscoped evidence cannot detect hidden duplicates or distinguish absent from restricted rows. No judgments or metric denominators are changed.",
    counts,
    judgments,
  };
}

export type FixtureFreshness = Awaited<ReturnType<typeof checkFixtureFreshness>>;
