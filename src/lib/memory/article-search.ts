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
import { resolveScopeAccess } from "@/lib/api/scope-filter";

const FALLBACK_SEARCH_MAX_SEED_TERMS = 8;
const FALLBACK_SEARCH_MAX_TERMS = 16;

const FALLBACK_SEARCH_STOP_WORDS = new Set([
  "a",
  "about",
  "after",
  "again",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "because",
  "being",
  "before",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "hers",
  "him",
  "his",
  "how",
  "if",
  "in",
  "is",
  "it",
  "its",
  "just",
  "like",
  "may",
  "me",
  "might",
  "my",
  "not",
  "of",
  "on",
  "or",
  "our",
  "ours",
  "shall",
  "she",
  "should",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "those",
  "this",
  "to",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "whether",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

const FALLBACK_SEARCH_SYNONYMS: string[][] = [
  ["photo", "photos", "image", "images", "picture", "pictures", "portrait"],
  ["avatar", "profile", "portrait"],
  ["screenshot", "screenshots", "image", "images", "picture", "pictures"],
  ["attach", "attached", "attachment", "attachments", "file", "files", "upload", "uploaded"],
];

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ArticleSearchFilters {
  topicSlug?: string;
  tagSlug?: string;
  status?: string;
  confidence?: string;
  /** Scopes to filter restricted articles. Unrestricted articles are always included. */
  allowedScopes?: string[];
}

// ─── Filter builder ──────────────────────────────────────────────────────────

/**
 * Build WHERE-clause filter fragments for article search.
 * Always excludes deleted and recall-quarantined articles.
 */
export function buildArticleSearchFilters(
  options: ArticleSearchFilters = {},
): Prisma.Sql[] {
  const clauses: Prisma.Sql[] = [
    Prisma.sql`a."deletedAt" IS NULL`,
    Prisma.sql`a."recallQuarantinedAt" IS NULL`,
  ];

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

  // Apply restricted-tag scope filtering.
  // undefined and [] both mean "unrestricted only" — only unrestricted articles.
  // Non-empty non-admin scopes: unrestricted OR hasSome.
  // "*": no filter (admin bypass).
  clauses.push(...buildRestrictedScopeSql(options.allowedScopes));

  return clauses;
}

/**
 * Parameterized raw-SQL realization of the canonical restricted-scope
 * interpretation. An empty array means unrestricted-only; "*" omits only this
 * predicate and never any other eligibility check.
 */
export function buildRestrictedScopeSql(
  allowedScopes: string[] | undefined,
): Prisma.Sql[] {
  const access = resolveScopeAccess(allowedScopes);
  if (access.kind === "all") return [];
  if (access.kind === "unrestricted") {
    return [Prisma.sql`coalesce(a."restrictedTags", '{}') = '{}'`];
  }
  return [
    Prisma.sql`(coalesce(a."restrictedTags", '{}') = '{}' OR a."restrictedTags" && ${access.scopes})`,
  ];
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

/**
 * Build a less strict fallback tsquery for conversational recall misses.
 *
 * `websearch_to_tsquery` is intentionally precise, but ordinary user phrasing
 * can include words that are absent from the durable article ("forgot",
 * "reattach") while still naming the concept ("photo"). This fallback is used
 * only after the strict query returns zero rows, and keeps the term set bounded
 * so broad searches do not swamp normal relevance ranking.
 */
export function buildFallbackSearchTsQuery(query: string): Prisma.Sql | null {
  const terms = extractFallbackSearchTerms(query);
  if (terms.length === 0) return null;

  return Prisma.sql`to_tsquery('simple', ${terms.join(" | ")})`;
}

export function extractFallbackSearchTerms(query: string): string[] {
  // The strict websearch_to_tsquery path retains Unicode. This secondary,
  // zero-result fallback intentionally folds Latin diacritics (café -> cafe)
  // and emits only bounded ASCII lexemes that cannot carry tsquery operators.
  const seeds = query
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3 && !FALLBACK_SEARCH_STOP_WORDS.has(term))
    .slice(0, FALLBACK_SEARCH_MAX_SEED_TERMS);

  const terms = new Set<string>();

  for (const seed of seeds) {
    addFallbackSearchTerm(terms, seed);

    const synonymGroup = FALLBACK_SEARCH_SYNONYMS.find((group) =>
      group.includes(seed),
    );
    if (synonymGroup) {
      for (const synonym of synonymGroup) {
        addFallbackSearchTerm(terms, synonym);
      }
    }

    if (terms.size >= FALLBACK_SEARCH_MAX_TERMS) break;
  }

  return [...terms].slice(0, FALLBACK_SEARCH_MAX_TERMS);
}

function addFallbackSearchTerm(terms: Set<string>, term: string): void {
  if (!/^[a-z0-9]+$/.test(term)) return;
  if (FALLBACK_SEARCH_STOP_WORDS.has(term)) return;
  terms.add(term);
}
