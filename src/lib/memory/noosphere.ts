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
    const rows = await this.searchArticleRows(normalizedQuery, {
      limit,
      offset: normalizeOffset(metadata.offset),
      topicSlug: metadata.topicSlug ?? options.scope,
      tagSlug: metadata.tagSlug,
      status: metadata.status,
      confidence: metadata.confidence,
    });

    if (rows.length === 0) {
      return [];
    }

    const articles = await this.prisma.article.findMany({
      where: {
        id: {
          in: rows.map((row) => row.id),
        },
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

    const articleById = new Map(articles.map((article) => [article.id, article]));

    return rows.flatMap((row) => {
      const article = articleById.get(row.id);
      if (!article) {
        return [];
      }

      return [this.toMemoryResult(article, row.relevanceScore)];
    });
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
      reasons: [
        "Noosphere articles are curated durable knowledge.",
        confidenceScore === undefined
          ? "Article has no explicit confidence label."
          : "Confidence score mapped from article confidence label.",
        "Recency score decays from the article updated timestamp.",
        "Aggregate score averages available relevance, confidence, and recency signals.",
      ],
    };
  }

  private async searchArticleRows(
    query: string,
    options: {
      topicSlug?: string;
      tagSlug?: string;
      status?: string;
      confidence?: string;
      limit?: number;
      offset: number;
    },
  ): Promise<{ id: string; rank: number; relevanceScore: number }[]> {
    const filters = buildSearchFilters(options);
    const limitClause =
      options.limit === undefined ? Prisma.empty : Prisma.sql`LIMIT ${options.limit}`;

    const rows = await this.prisma.$queryRaw<
      { id: string; rank: number | string }[]
    >(Prisma.sql`
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
      SELECT
        id,
        ts_rank(document, websearch_to_tsquery('simple', ${query})) AS rank
      FROM searchable
      WHERE document @@ websearch_to_tsquery('simple', ${query})
      ORDER BY rank DESC, "updatedAt" DESC
      ${limitClause}
      OFFSET ${options.offset}
    `);

    const maxRank = Math.max(
      ...rows.map((row) => normalizeRank(row.rank)),
      0,
    );

    return rows.map((row) => {
      const rank = normalizeRank(row.rank);
      return {
        id: row.id,
        rank,
        relevanceScore:
          maxRank === 0 ? 0 : rank / maxRank,
      };
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
        sourceType: article.sourceType ?? undefined,
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
  if (optionLimit !== undefined) {
    return normalizeOptionalLimit(optionLimit);
  }

  if (
    configOverride &&
    Object.prototype.hasOwnProperty.call(configOverride, "maxResults")
  ) {
    return normalizeOptionalLimit(configOverride.maxResults);
  }

  return config.maxResults ?? DEFAULT_NOOSPHERE_MAX_RESULTS;
}

function normalizeOptionalLimit(limit: number | undefined): number | undefined {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return undefined;
  }

  return Math.max(1, Math.floor(limit));
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset) || offset < 0) {
    return 0;
  }

  return Math.floor(offset);
}
