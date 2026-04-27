/**
 * Shared full-text article search CTE builder.
 *
 * Both the wiki search layer (`src/lib/wiki.ts`) and the Noosphere memory
 * provider (`src/lib/memory/noosphere.ts`) need to build the same weighted
 * tsvector document over article title (A), excerpt (B), content (C), and
 * tag names (B). This module provides a single source of truth for that CTE
 * so the ranking logic cannot drift between the two consumers.
 *
 * @module article-search
 */

import { Prisma } from "@prisma/client";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ArticleSearchFilters {
  topicSlug?: string;
  tagSlug?: string;
  status?: string;
  confidence?: string;
}

// ─── Filter builder ──────────────────────────────────────────────────────────

/**
 * Build WHERE-clause filter fragments for article search.
 * Always includes `a."deletedAt" IS NULL`.
 */
export function buildArticleSearchFilters(
  options: ArticleSearchFilters = {},
): Prisma.Sql[] {
  const clauses: Prisma.Sql[] = [Prisma.sql`a."deletedAt" IS NULL`];

  if (options.topicSlug) {
    clauses.push(Prisma.sql`tpc.slug = ${options.topicSlug}`);
  }
  if (options.tagSlug) {
    clauses.push(
      Prisma.sql`EXISTS (
        SELECT 1
        FROM "ArticleTag" at_filter
        INNER JOIN "Tag" tag_filter ON tag_filter.id = at_filter."tagId"
        WHERE at_filter."articleId" = a.id
          AND tag_filter.slug = ${options.tagSlug}
      )`,
    );
  }
  if (options.status) {
    clauses.push(Prisma.sql`a.status = ${options.status}`);
  }
  if (options.confidence) {
    clauses.push(Prisma.sql`a.confidence = ${options.confidence}`);
  }

  return clauses;
}

// ─── CTE builder ─────────────────────────────────────────────────────────────

/**
 * Build the shared `searchable` CTE that computes a weighted tsvector document
 * over article fields. Returns a `Prisma.Sql` fragment that can be embedded in
 * a larger raw query.
 *
 * The document weights are:
 * - Title → A (highest)
 * - Excerpt → B
 * - Content → C
 * - Tag names → B
 *
 * The CTE exposes: `id`, `updatedAt`, `document` (tsvector).
 */
export function buildSearchableCTE(
  filters: Prisma.Sql[],
): Prisma.Sql {
  // Fallback to a tautology if no filters are provided, so the generated
  // SQL is always valid (WHERE TRUE instead of bare WHERE).
  const whereClause = filters.length > 0
    ? Prisma.join(filters, " AND ")
    : Prisma.sql`TRUE`;

  return Prisma.sql`
    SELECT
      a.id,
      a."updatedAt",
      (
        setweight(to_tsvector('simple', coalesce(a.title, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(a.excerpt, '')), 'B') ||
        setweight(to_tsvector('simple', coalesce(a.content, '')), 'C') ||
        setweight(to_tsvector('simple', coalesce(string_agg(tg.name, ' '), '')), 'B')
      ) AS document
    FROM "Article" a
    INNER JOIN "Topic" tpc ON tpc.id = a."topicId"
    LEFT JOIN "ArticleTag" at ON at."articleId" = a.id
    LEFT JOIN "Tag" tg ON tg.id = at."tagId"
    WHERE ${whereClause}
    GROUP BY a.id
  `;
}

/**
 * Build a tsquery fragment from a user query string using `websearch_to_tsquery`.
 */
export function buildSearchTsQuery(query: string): Prisma.Sql {
  return Prisma.sql`websearch_to_tsquery('simple', ${query})`;
}
