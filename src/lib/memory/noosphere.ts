import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { buildSearchFilters } from "@/lib/wiki";

import type {
  MemoryProvider,
  MemoryProviderConfig,
  MemoryProviderDescriptor,
  MemoryProviderGetOptions,
  MemoryProviderScore,
  MemoryProviderScoreContext,
  MemoryProviderSearchOptions,
} from "./provider";
import { normalizeMemoryProviderConfig } from "./provider";
import {
  defineMemoryResult,
  normalizeMemoryScore,
  removeUndefined,
} from "./types";
import type { MemoryProviderMetadata, MemoryResult } from "./types";

export interface NoosphereProviderSettings {
  /** Optional Prisma client override for scripts, tests, or alternate runtimes. */
  prisma?: PrismaClient;

  /** Base provider config consumed by orchestrators. */
  providerConfig?: Partial<MemoryProviderConfig>;
}

export interface NoosphereSearchOptionsMetadata extends MemoryProviderMetadata {
  /** Restrict search to a topic slug. Defaults to options.scope when present. */
  topicSlug?: string;

  /** Restrict search to articles with this tag slug. */
  tagSlug?: string;

  /** Restrict search to a lifecycle status, for example "published". */
  status?: string;

  /** Restrict search to a confidence label, for example "high". */
  confidence?: string;

  /** Offset used by inspection/API callers that page through provider results. */
  offset?: number;
}

type NoosphereArticle = Prisma.ArticleGetPayload<{
  include: {
    topic: true;
    tags: {
      include: {
        tag: true;
      };
    };
  };
}>;

const NOOSPHERE_PROVIDER_ID = "noosphere";
const DEFAULT_NOOSPHERE_MAX_RESULTS = 10;
const RECENCY_HALF_LIFE_DAYS = 90;

export class NoosphereProvider implements MemoryProvider {
  readonly descriptor: MemoryProviderDescriptor;

  private readonly prisma: PrismaClient;

  constructor(settings: NoosphereProviderSettings = {}) {
    this.prisma = settings.prisma ?? defaultPrisma;

    this.descriptor = {
      id: NOOSPHERE_PROVIDER_ID,
      displayName: "Noosphere",
      sourceType: "noosphere",
      defaultConfig: {
        enabled: true,
        priorityWeight: 1.25,
        maxResults: DEFAULT_NOOSPHERE_MAX_RESULTS,
        allowAutoRecall: true,
        ...settings.providerConfig,
      },
      capabilities: {
        search: true,
        getById: true,
        score: true,
        autoRecall: true,
      },
      metadata: {
        contentType: "article",
      },
    };
  }

  async search(
    query: string,
    options: MemoryProviderSearchOptions = {},
  ): Promise<MemoryResult[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const config = normalizeMemoryProviderConfig({
      ...this.descriptor.defaultConfig,
      ...options.config,
    });
    if (!config.enabled) {
      return [];
    }

    const limit = resolveSearchLimit(options.limit, options.config, config);
    const metadata = (options.metadata ?? {}) as NoosphereSearchOptionsMetadata;
    const articles = await this.searchArticles(normalizedQuery, {
      limit,
      offset: normalizeOffset(metadata.offset),
      topicSlug: metadata.topicSlug ?? options.scope,
      tagSlug: metadata.tagSlug,
      status: metadata.status,
      confidence: metadata.confidence,
    });

    return articles;
  }

  async getById(
    id: string,
    options: MemoryProviderGetOptions = {},
  ): Promise<MemoryResult | null> {
    const config = normalizeMemoryProviderConfig({
      ...this.descriptor.defaultConfig,
      ...options.config,
    });
    if (!config.enabled) {
      return null;
    }

    const articleId = parseNoosphereArticleId(id);
    const article = await this.prisma.article.findFirst({
      where: {
        id: articleId,
        deletedAt: null,
      },
      include: {
        topic: true,
        tags: {
          include: {
            tag: true,
          },
        },
      },
    });

    return article ? this.toMemoryResult(article) : null;
  }

  score(
    result: MemoryResult,
    context: MemoryProviderScoreContext = {},
  ): MemoryProviderScore {
    if (result.provider !== NOOSPHERE_PROVIDER_ID) {
      return {};
    }

    const relevanceScore = result.relevanceScore;
    const confidenceScore = result.confidenceScore;
    const recencyScore = result.updatedAt
      ? mapRecencyScore(new Date(result.updatedAt), context.now)
      : result.recencyScore;
    const scoredValues = [relevanceScore, confidenceScore, recencyScore].filter(
      (score): score is number => score !== undefined,
    );
    const reasons = [
      "Noosphere articles are curated durable knowledge.",
      confidenceScore === undefined
        ? "Article has no explicit confidence label."
        : "Confidence score mapped from article confidence label.",
      "Recency score decays from the article updated timestamp.",
    ];

    if (scoredValues.length > 0) {
      reasons.push(
        "Aggregate score averages available relevance, confidence, and recency signals.",
      );
    }

    return {
      relevanceScore,
      confidenceScore,
      recencyScore,
      aggregateScore:
        scoredValues.length === 0
          ? undefined
          : normalizeMemoryScore(
              scoredValues.reduce((sum, score) => sum + score, 0) /
                scoredValues.length,
            ),
      reasons,
    };
  }

  /**
   * Single-query search: returns fully-hydrated MemoryResult[] directly from the
   * database, eliminating the previous two-query pattern (rank IDs → findMany).
   *
   * The CTE computes full-text rank, then joins back to Article+Topic+Tag rows
   * so we get both the relevance score and article data in one round-trip.
   */
  private async searchArticles(
    query: string,
    options: {
      topicSlug?: string;
      tagSlug?: string;
      status?: string;
      confidence?: string;
      limit?: number;
      offset: number;
    },
  ): Promise<MemoryResult[]> {
    const filters = buildSearchFilters(options);
    const limitClause =
      options.limit === undefined ? Prisma.empty : Prisma.sql`LIMIT ${options.limit}`;

    // Raw query returns flat rows — we'll aggregate tags in JS.
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        rank: number | string;
        title: string;
        slug: string;
        content: string;
        excerpt: string | null;
        status: string;
        confidence: string | null;
        sourceUrl: string | null;
        sourceType: string | null;
        createdAt: Date;
        updatedAt: Date;
        lastReviewed: Date | null;
        authorId: string | null;
        authorName: string | null;
        topicId: string;
        topicSlug: string;
        topicName: string;
        tagName: string | null;
      }[]
    >(Prisma.sql`
      WITH ranked AS (
        SELECT
          a.id,
          a."updatedAt",
          ts_rank(
            setweight(to_tsvector('simple', coalesce(a.title, '')), 'A') ||
            setweight(to_tsvector('simple', coalesce(a.excerpt, '')), 'B') ||
            setweight(to_tsvector('simple', coalesce(a.content, '')), 'C') ||
            setweight(to_tsvector('simple', coalesce(string_agg(tg.name, ' '), '')), 'B'),
            websearch_to_tsquery('simple', ${query})
          ) AS rank
        FROM "Article" a
        INNER JOIN "Topic" tpc ON tpc.id = a."topicId"
        LEFT JOIN "ArticleTag" at ON at."articleId" = a.id
        LEFT JOIN "Tag" tg ON tg.id = at."tagId"
        WHERE ${Prisma.join(filters, " AND ")}
        GROUP BY a.id, a.title, a.excerpt, a.content, a."updatedAt"
        HAVING ts_rank(
          setweight(to_tsvector('simple', coalesce(a.title, '')), 'A') ||
          setweight(to_tsvector('simple', coalesce(a.excerpt, '')), 'B') ||
          setweight(to_tsvector('simple', coalesce(a.content, '')), 'C') ||
          setweight(to_tsvector('simple', coalesce(string_agg(tg.name, ' '), '')), 'B'),
          websearch_to_tsquery('simple', ${query})
        ) > 0
        ORDER BY rank DESC, a."updatedAt" DESC
        ${limitClause}
        OFFSET ${options.offset}
      )
      SELECT
        r.id, r.rank,
        a.title, a.slug, a.content, a.excerpt, a.status, a.confidence,
        a."sourceUrl", a."sourceType",
        a."createdAt", a."updatedAt", a."lastReviewed",
        a."authorId", a."authorName",
        tpc.id AS "topicId", tpc.slug AS "topicSlug", tpc.name AS "topicName",
        tg.name AS "tagName"
      FROM ranked r
      INNER JOIN "Article" a ON a.id = r.id
      INNER JOIN "Topic" tpc ON tpc.id = a."topicId"
      LEFT JOIN "ArticleTag" at2 ON at2."articleId" = a.id
      LEFT JOIN "Tag" tg ON tg.id = at2."tagId"
      ORDER BY r.rank DESC, a."updatedAt" DESC
    `);

    if (rows.length === 0) {
      return [];
    }

    // Compute max rank for relative relevance scoring.
    const maxRank = rows.reduce(
      (max, row) => Math.max(max, normalizeRank(row.rank)),
      0,
    );

    // Aggregate flat rows (one per tag) into article groups.
    const articleMap = new Map<
      string,
      {
        row: (typeof rows)[number];
        tags: string[];
      }
    >();

    for (const row of rows) {
      const existing = articleMap.get(row.id);
      if (existing) {
        if (row.tagName) {
          existing.tags.push(row.tagName);
        }
      } else {
        articleMap.set(row.id, {
          row,
          tags: row.tagName ? [row.tagName] : [],
        });
      }
    }

    // Preserve rank-descending order from the query.
    const seenIds = new Set<string>();
    const results: MemoryResult[] = [];

    for (const row of rows) {
      if (seenIds.has(row.id)) continue;
      seenIds.add(row.id);

      const entry = articleMap.get(row.id)!;
      const rank = normalizeRank(entry.row.rank);
      const relevanceScore = maxRank === 0 ? 0 : rank / maxRank;

      results.push(
        this.toMemoryResultFromRow(entry.row, entry.tags, relevanceScore),
      );
    }

    return results;
  }

  /**
   * Build a MemoryResult from a raw SQL row (single-query path).
   * Avoids the Prisma include/hydration overhead of toMemoryResult().
   */
  private toMemoryResultFromRow(
    row: {
      id: string;
      title: string;
      slug: string;
      content: string;
      excerpt: string | null;
      status: string;
      confidence: string | null;
      sourceUrl: string | null;
      sourceType: string | null;
      createdAt: Date | string;
      updatedAt: Date | string;
      lastReviewed: Date | string | null;
      authorId: string | null;
      authorName: string | null;
      topicId: string;
      topicSlug: string;
      topicName: string;
    },
    tags: string[],
    relevanceScore?: number,
  ): MemoryResult {
    const updatedAt =
      row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt);
    const createdAt =
      row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
    const lastReviewed =
      row.lastReviewed == null
        ? undefined
        : row.lastReviewed instanceof Date
          ? row.lastReviewed
          : new Date(row.lastReviewed);

    return defineMemoryResult({
      id: row.id,
      provider: NOOSPHERE_PROVIDER_ID,
      sourceType: "noosphere",
      title: row.title,
      content: row.content,
      summary: row.excerpt ?? undefined,
      relevanceScore,
      confidenceScore: mapConfidenceScore(row.confidence),
      recencyScore: mapRecencyScore(updatedAt),
      curationLevel: mapCurationLevel(row.status),
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
      canonicalRef: `noosphere:article:${row.id}`,
      tags,
      metadata: removeUndefined({
        articleId: row.id,
        articleSlug: row.slug,
        topicId: row.topicId,
        topicSlug: row.topicSlug,
        topicName: row.topicName,
        wikiPath: `/wiki/${row.topicSlug}/${row.slug}`,
        sourceUrl: row.sourceUrl ?? undefined,
        articleSourceType: row.sourceType ?? undefined,
        status: row.status,
        confidence: row.confidence ?? undefined,
        lastReviewed: lastReviewed?.toISOString(),
        authorId: row.authorId ?? undefined,
        authorName: row.authorName ?? undefined,
      }),
    });
  }

  private toMemoryResult(
    article: NoosphereArticle,
    relevanceScore?: number,
  ): MemoryResult {
    const tags = article.tags.map(({ tag }) => tag.name);

    return defineMemoryResult({
      id: article.id,
      provider: NOOSPHERE_PROVIDER_ID,
      sourceType: "noosphere",
      title: article.title,
      content: article.content,
      summary: article.excerpt ?? undefined,
      relevanceScore,
      confidenceScore: mapConfidenceScore(article.confidence),
      recencyScore: mapRecencyScore(article.updatedAt),
      curationLevel: mapCurationLevel(article.status),
      createdAt: article.createdAt.toISOString(),
      updatedAt: article.updatedAt.toISOString(),
      canonicalRef: `noosphere:article:${article.id}`,
      tags,
      metadata: removeUndefined({
        articleId: article.id,
        articleSlug: article.slug,
        topicId: article.topic.id,
        topicSlug: article.topic.slug,
        topicName: article.topic.name,
        wikiPath: `/wiki/${article.topic.slug}/${article.slug}`,
        sourceUrl: article.sourceUrl ?? undefined,
        articleSourceType: article.sourceType ?? undefined,
        status: article.status,
        confidence: article.confidence ?? undefined,
        lastReviewed: article.lastReviewed?.toISOString(),
        authorId: article.authorId ?? undefined,
        authorName: article.authorName ?? undefined,
      }),
    });
  }
}

export function createNoosphereProvider(
  settings: NoosphereProviderSettings = {},
): NoosphereProvider {
  return new NoosphereProvider(settings);
}

function mapConfidenceScore(confidence: string | null): number | undefined {
  switch (confidence) {
    case "high":
      return 1;
    case "medium":
      return 0.66;
    case "low":
      return 0.33;
    default:
      return undefined;
  }
}

function mapCurationLevel(status: string): MemoryResult["curationLevel"] {
  switch (status) {
    case "published":
      return "curated";
    case "reviewed":
      return "reviewed";
    case "draft":
      return "ephemeral";
    default:
      return "reviewed";
  }
}

function mapRecencyScore(
  updatedAt: Date | null | undefined,
  now = new Date(),
): number | undefined {
  if (!updatedAt) {
    return undefined;
  }

  const ageMs = now.getTime() - updatedAt.getTime();
  if (ageMs <= 0) {
    return 1;
  }

  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return normalizeMemoryScore(
    Math.exp((-ageDays * Math.LN2) / RECENCY_HALF_LIFE_DAYS),
  );
}

function parseNoosphereArticleId(id: string): string {
  const prefix = "noosphere:article:";
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function normalizeRank(rank: number | string): number {
  const normalizedRank = typeof rank === "number" ? rank : Number(rank);
  return Number.isFinite(normalizedRank) ? Math.max(0, normalizedRank) : 0;
}

function resolveSearchLimit(
  optionLimit: number | undefined,
  configOverride: Partial<MemoryProviderConfig> | undefined,
  config: MemoryProviderConfig,
): number | undefined {
  // Priority: explicit option > config override > default config > hardcoded default.
  if (optionLimit !== undefined) {
    return normalizeExplicitLimit(optionLimit) ?? DEFAULT_NOOSPHERE_MAX_RESULTS;
  }

  const overrideMax = configOverride?.maxResults;
  if (overrideMax !== undefined) {
    return normalizeExplicitLimit(overrideMax) ?? DEFAULT_NOOSPHERE_MAX_RESULTS;
  }

  // If the override explicitly set maxResults to undefined (unset), use no cap.
  if (
    configOverride &&
    Object.prototype.hasOwnProperty.call(configOverride, "maxResults")
  ) {
    return undefined;
  }

  return config.maxResults ?? DEFAULT_NOOSPHERE_MAX_RESULTS;
}

function normalizeExplicitLimit(limit: number): number | undefined {
  if (!Number.isFinite(limit) || limit < 0) {
    return undefined;
  }

  return Math.floor(limit);
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset) || offset < 0) {
    return 0;
  }

  return Math.floor(offset);
}
