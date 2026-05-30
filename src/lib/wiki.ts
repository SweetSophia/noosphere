import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  type ArticleSearchFilters,
  buildArticleSearchFilters,
  buildSearchableCTE,
  buildSearchTsQuery,
} from "@/lib/memory/article-search";
import { normalizeTagInputs } from "./wiki-utils";

export { slugify, parseTagInput, normalizeTagInputs } from "./wiki-utils";
export type { NormalizedTagInput } from "./wiki-utils";

export async function buildTagConnections(tagNames: string[]) {
  if (!tagNames.length) return [];

  const tags = normalizeTagInputs(tagNames);
  if (!tags.length) return [];

  // Preserve the previous upsert behavior while avoiding per-tag round-trips.
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "Tag" ("id", "name", "slug")
    VALUES ${Prisma.join(
      tags.map((tag) => Prisma.sql`(${randomUUID()}, ${tag.name}, ${tag.slug})`)
    )}
    ON CONFLICT ("slug") DO UPDATE SET "name" = EXCLUDED."name"
  `);

  const slugs = tags.map((tag) => tag.slug);
  const found = await prisma.tag.findMany({
    where: { slug: { in: slugs } },
    select: { id: true, slug: true },
  });

  const bySlug = new Map(found.map((t) => [t.slug, t.id]));

  return tags
    .map((tag) => {
      const id = bySlug.get(tag.slug);
      return id ? { tagId: id } : null;
    })
    .filter((c): c is { tagId: string } => c !== null);
}

export interface SearchArticlesOptions extends ArticleSearchFilters {
  limit?: number;
  offset?: number;
  /** Scopes for restricted-article filtering. */
  allowedScopes?: string[];
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
  const filters = buildArticleSearchFilters({
    topicSlug: options.topicSlug,
    tagSlug: options.tagSlug,
    status: options.status,
    confidence: options.confidence,
    allowedScopes: options.allowedScopes,
  });
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

  const filters = buildArticleSearchFilters({
    topicSlug: options.topicSlug,
    tagSlug: options.tagSlug,
    status: options.status,
    confidence: options.confidence,
    allowedScopes: options.allowedScopes,
  });
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
