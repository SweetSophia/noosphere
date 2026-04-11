import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

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

interface SearchArticlesOptions {
  topicSlug?: string;
  tagSlug?: string;
  status?: string;
  confidence?: string;
  limit?: number;
  offset?: number;
}

function buildSearchFilters(options: SearchArticlesOptions) {
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
      )`
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

// Use PostgreSQL full-text search so article search ranks meaningful matches
// instead of only doing plain substring scans across large markdown blobs.
export async function searchArticleIds(
  rawQuery: string,
  options: SearchArticlesOptions = {}
): Promise<string[]> {
  const query = rawQuery.trim();
  if (!query) return [];

  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  const filters = buildSearchFilters(options);

  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    WITH searchable AS (
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
      WHERE ${Prisma.join(filters, " AND ")}
      GROUP BY a.id, a.title, a.excerpt, a.content, a."updatedAt"
    )
    SELECT id
    FROM searchable
    WHERE document @@ websearch_to_tsquery('simple', ${query})
    ORDER BY ts_rank(document, websearch_to_tsquery('simple', ${query})) DESC, "updatedAt" DESC
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

  const filters = buildSearchFilters(options);
  const rows = await prisma.$queryRaw<{ total: bigint | number }[]>(Prisma.sql`
    WITH searchable AS (
      SELECT
        a.id,
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
      WHERE ${Prisma.join(filters, " AND ")}
      GROUP BY a.id, a.title, a.excerpt, a.content
    )
    SELECT COUNT(*)::bigint AS total
    FROM searchable
    WHERE document @@ websearch_to_tsquery('simple', ${query})
  `);

  const total = rows[0]?.total ?? 0;
  return typeof total === "bigint" ? Number(total) : total;
}
