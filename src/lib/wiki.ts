import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  buildArticleSearchFilters,
  buildSearchableCTE,
  buildSearchTsQuery,
} from "@/lib/memory/article-search";

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

export function parseTagInput(raw: string | null | undefined): string[] {
  if (!raw) return [];

  return Array.from(
    new Set(
      raw
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  );
}

export async function buildTagConnections(tagNames: string[]) {
  if (!tagNames.length) return [];

  return Promise.all(
    tagNames.map(async (tagName) => {
      const tagSlug = slugify(tagName);
      const tag = await prisma.tag.upsert({
        where: { slug: tagSlug },
        create: { name: tagName, slug: tagSlug },
        update: { name: tagName },
      });

      return { tagId: tag.id };
    })
  );
}

export interface SearchArticlesOptions {
  topicSlug?: string;
  tagSlug?: string;
  status?: string;
  confidence?: string;
  limit?: number;
  offset?: number;
}

// Use PostgreSQL full-text search so article search ranks meaningful matches
// instead of only doing plain substring scans across large markdown blobs.

// Re-export shared filter builder for backward compatibility.
export { buildArticleSearchFilters as buildSearchFilters } from "@/lib/memory/article-search";

export async function searchArticleIds(
  rawQuery: string,
  options: SearchArticlesOptions = {}
): Promise<string[]> {
  const query = rawQuery.trim();
  if (!query) return [];

  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  const filters = buildArticleSearchFilters(options);
  const cte = buildSearchableCTE(filters);
  const tsQuery = buildSearchTsQuery(query);

  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    WITH searchable AS (
      ${cte}
    )
    SELECT id
    FROM searchable
    WHERE document @@ ${tsQuery}
    ORDER BY ts_rank(document, ${tsQuery}) DESC, "updatedAt" DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `);

  return rows.map((row) => row.id);
}

export async function countSearchArticles(
  rawQuery: string,
  options: Omit<SearchArticlesOptions, "limit" | "offset"> = {}
): Promise<number> {
  const query = rawQuery.trim();
  if (!query) return 0;

  const filters = buildArticleSearchFilters(options);
  const cte = buildSearchableCTE(filters);
  const tsQuery = buildSearchTsQuery(query);

  const rows = await prisma.$queryRaw<{ total: bigint | number }[]>(Prisma.sql`
    WITH searchable AS (
      ${cte}
    )
    SELECT COUNT(*)::bigint AS total
    FROM searchable
    WHERE document @@ ${tsQuery}
  `);

  const total = rows[0]?.total ?? 0;
  return typeof total === "bigint" ? Number(total) : total;
}
