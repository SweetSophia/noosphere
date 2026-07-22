import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import {
  buildArticleSearchFilters,
  buildFallbackSearchTsQuery,
  buildSearchableCTE,
  buildSearchTsQuery,
} from "@/lib/memory/article-search";

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
import {
  DEFAULT_NOOSPHERE_MAX_RESULTS,
  NOOSPHERE_PROVIDER_DESCRIPTOR,
  NOOSPHERE_PROVIDER_ID,
} from "./noosphere-descriptor";
import {
  buildSearchCacheKey,
  type CachedSearchResultRef,
  getCachedSearchResults,
  getSearchCacheVersion,
  setCachedSearchResults,
} from "@/lib/cache/search-cache";
import { withSerializableRetry } from "@/lib/memory/capture/repository";
import {
  HybridLexicalFallbackError,
  readHybridRetrievalConfig,
} from "@/lib/memory/hybrid-retrieval";
import {
  searchHybridArticles,
  type HybridArticleRow,
} from "@/lib/memory/hybrid-retrieval-runtime";
import { HYBRID_MAX_WINDOW } from "@/lib/memory/hybrid-ranking";

export interface NoosphereProviderSettings {
  /** Optional Prisma client override for scripts, tests, or alternate runtimes. */
  prisma?: PrismaClient;

  /** Base provider config consumed by orchestrators. */
  providerConfig?: Partial<MemoryProviderConfig>;

  /** Scopes for restricted-article filtering. */
  allowedScopes?: string[];

  /** Environment override used by deterministic tests and isolated runtimes. */
  environment?: Readonly<Record<string, string | undefined>>;

  /** Phase C runtime override used by focused provider contract tests. */
  hybridSearch?: typeof searchHybridArticles;
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

const RECENCY_HALF_LIFE_DAYS = 90;

type SearchArticleRow = {
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
};

export class NoosphereProvider implements MemoryProvider {
  readonly descriptor: MemoryProviderDescriptor;

  private readonly prisma: PrismaClient;
  private readonly allowedScopes?: string[];
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly hybridSearch: typeof searchHybridArticles;

  constructor(settings: NoosphereProviderSettings = {}) {
    this.prisma = settings.prisma ?? defaultPrisma;
    this.allowedScopes = settings.allowedScopes;
    this.environment = settings.environment ?? process.env;
    this.hybridSearch = settings.hybridSearch ?? searchHybridArticles;

    this.descriptor = {
      ...NOOSPHERE_PROVIDER_DESCRIPTOR,
      defaultConfig: {
        ...NOOSPHERE_PROVIDER_DESCRIPTOR.defaultConfig,
        ...settings.providerConfig,
      },
      capabilities: { ...NOOSPHERE_PROVIDER_DESCRIPTOR.capabilities },
      metadata: { ...NOOSPHERE_PROVIDER_DESCRIPTOR.metadata },
    };
  }

  /**
   * Build a Prisma scope-filter fragment for article queries.
   * Returns undefined if admin (*) — meaning no filter needed.
   */
  private buildScopeWhere(): Record<string, unknown> | undefined {
    if (this.allowedScopes?.includes("*")) {
      return undefined; // admin: no filter
    }
    if (!this.allowedScopes || this.allowedScopes.length === 0) {
      return { restrictedTags: { isEmpty: true } }; // no scopes: unrestricted only
    }
    return {
      OR: [
        { restrictedTags: { isEmpty: true } },
        { restrictedTags: { hasSome: this.allowedScopes } },
      ],
    };
  }

  async search(
    query: string,
    options: MemoryProviderSearchOptions = {},
  ): Promise<MemoryResult[]> {
    const config = normalizeMemoryProviderConfig({
      ...this.descriptor.defaultConfig,
      ...options.config,
    });
    if (!config.enabled) {
      return [];
    }

    // A globally enabled Phase C configuration must fail closed even for
    // requests that can otherwise short-circuit without retrieval work.
    const hybridConfig = readHybridRetrievalConfig(this.environment);
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const limit = resolveSearchLimit(options.limit, options.config, config);
    if (limit === 0) {
      return [];
    }
    const metadata = (options.metadata ?? {}) as NoosphereSearchOptionsMetadata;
    const offset = normalizeOffset(metadata.offset);
    let hybridFallbackReason: string | undefined;

    if (
      hybridConfig.enabled &&
      limit !== undefined &&
      offset + limit <= HYBRID_MAX_WINDOW
    ) {
      try {
        const rows = await this.hybridSearch(
          this.prisma,
          {
            query: normalizedQuery,
            limit,
            offset,
            filters: {
              topicSlug: metadata.topicSlug ?? options.scope,
              tagSlug: metadata.tagSlug,
              status: metadata.status,
              confidence: metadata.confidence,
            },
            allowedScopes: this.allowedScopes,
            signal: options.signal,
          },
          hybridConfig,
          this.environment,
        );
        return rows.map((row) => this.toHybridMemoryResult(row));
      } catch (error) {
        if (!(error instanceof HybridLexicalFallbackError)) throw error;
        hybridFallbackReason = normalizeHybridFallbackReason(error.code);
        console.warn("[hybrid-retrieval] lexical fallback", {
          code: hybridFallbackReason,
        });
      }
    } else if (hybridConfig.enabled) {
      hybridFallbackReason = limit === undefined
        ? "limit_unbounded"
        : "window_exceeded";
      console.warn("[hybrid-retrieval] lexical fallback", {
        code: hybridFallbackReason,
      });
    }

    const cacheVersion = await getSearchCacheVersion();
    const cacheKey = cacheVersion === null
      ? null
      : buildSearchCacheKey({
          query: normalizedQuery,
          topicSlug: metadata.topicSlug ?? options.scope,
          tagSlug: metadata.tagSlug,
          status: metadata.status,
          confidence: metadata.confidence,
          limit,
          offset,
          allowedScopes: this.allowedScopes,
          cacheVersion,
        });

    if (cacheKey) {
      const cachedResults = await getCachedSearchResults(cacheKey);
      if (cachedResults !== null) {
        const cachedArticles = await this.hydrateEligibleArticleRefs(cachedResults);
        return annotateHybridFallback(cachedArticles, hybridFallbackReason);
      }
    }

    // Cache miss - proceed with database query
    const rankedArticles = await this.searchArticles(normalizedQuery, {
      limit,
      offset,
      topicSlug: metadata.topicSlug ?? options.scope,
      tagSlug: metadata.tagSlug,
      status: metadata.status,
      confidence: metadata.confidence,
      allowedScopes: this.allowedScopes,
    });
    const articles = await this.hydrateEligibleArticleRefs(
      rankedArticles.map(({ id, relevanceScore }) => ({ id, relevanceScore })),
    );

    if (cacheKey && cacheVersion !== null) {
      // Start best-effort cache population if the invalidation version is unchanged.
      void setCachedSearchResults(cacheKey, articles, cacheVersion);
    }

    return annotateHybridFallback(articles, hybridFallbackReason);
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

    const results = await this.hydrateEligibleArticleRefs([
      { id: parseNoosphereArticleId(id) },
    ]);
    return results[0] ?? null;
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
      allowedScopes?: string[];
    },
  ): Promise<MemoryResult[]> {
    const filters = buildArticleSearchFilters(options);
    const cte = buildSearchableCTE(filters);
    const strictTsQuery = buildSearchTsQuery(query);
    const limitClause =
      options.limit === undefined ? Prisma.empty : Prisma.sql`LIMIT ${options.limit}`;

    let rows = await this.queryRankedArticleRows(cte, strictTsQuery, limitClause, options.offset);

    const shouldTryFallback =
      rows.length === 0 &&
      (options.offset === 0 || !(await this.hasSearchMatches(cte, strictTsQuery)));

    if (shouldTryFallback) {
      const fallbackTsQuery = buildFallbackSearchTsQuery(query);
      if (fallbackTsQuery) {
        rows = await this.queryRankedArticleRows(cte, fallbackTsQuery, limitClause, options.offset);
      }
    }

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
   * Treat search/cache records only as ranking hints. The final article and all
   * provenance lineages are locked in one transaction before current content is
   * hydrated. This gives recall the same lineage -> article lock order as
   * privacy revocation: whichever transaction acquires the lineage lock first
   * wins serialization, and a winning revocation cannot leak through Redis.
   */
  private async hydrateEligibleArticleRefs(
    refs: CachedSearchResultRef[],
  ): Promise<MemoryResult[]> {
    if (refs.length === 0) return [];

    const ids = [...new Set(refs.map(({ id }) => parseNoosphereArticleId(id)))];
    const relevanceById = new Map(
      refs.map(({ id, relevanceScore }) => [
        parseNoosphereArticleId(id),
        relevanceScore,
      ]),
    );

    return withSerializableRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
        const lineageRows = await tx.$queryRaw<
          Array<{
            articleId: string;
            sourceGroupId: string;
            generation: number;
            generationSnapshot: number;
            revokedAt: Date | null;
          }>
        >(Prisma.sql`
          SELECT edge."articleId", edge."sourceGroupId", lineage."generation",
                 edge."generationSnapshot", lineage."revokedAt"
          FROM "MemoryProvenanceEdge" edge
          INNER JOIN "MemoryLineageState" lineage
            ON lineage.id = edge."lineageStateId"
          WHERE edge."articleId" IN (${Prisma.join(ids)})
          ORDER BY lineage."kind"::text, lineage."subjectHash", lineage.id
          FOR SHARE OF lineage
        `);
        const provenanceByArticle = new Map<
          string,
          Map<string, typeof lineageRows>
        >();
        for (const row of lineageRows) {
          const groups = provenanceByArticle.get(row.articleId) ?? new Map();
          const group = groups.get(row.sourceGroupId) ?? [];
          group.push(row);
          groups.set(row.sourceGroupId, group);
          provenanceByArticle.set(row.articleId, groups);
        }
        const blockedIds = new Set(
          [...provenanceByArticle.entries()]
            .filter(([, groups]) =>
              [...groups.values()].every((group) =>
                group.some(
                  ({ generation, generationSnapshot, revokedAt }) =>
                    revokedAt !== null || generation !== generationSnapshot,
                ),
              ),
            )
            .map(([articleId]) => articleId),
        );
        const candidateIds = ids.filter((articleId) => !blockedIds.has(articleId));
        if (candidateIds.length === 0) return [];

        const lockedRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT article.id
          FROM "Article" article
          WHERE article.id IN (${Prisma.join(candidateIds)})
            AND article."deletedAt" IS NULL
            AND article."recallQuarantinedAt" IS NULL
          ORDER BY article.id
          FOR SHARE OF article
        `);
        const eligibleIds = lockedRows.map(({ id: articleId }) => articleId);
        if (eligibleIds.length === 0) return [];

        const scopeWhere = this.buildScopeWhere();
        const articles = await tx.article.findMany({
          where: {
            id: { in: eligibleIds },
            deletedAt: null,
            recallQuarantinedAt: null,
            ...(scopeWhere ?? {}),
          },
          include: {
            topic: true,
            tags: { include: { tag: true } },
          },
        });
        const byId = new Map(articles.map((article) => [article.id, article]));

        return ids.flatMap((articleId) => {
          const article = byId.get(articleId);
          return article
            ? [this.toMemoryResult(article, relevanceById.get(articleId))]
            : [];
        });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  private async hasSearchMatches(
    cte: Prisma.Sql,
    tsQuery: Prisma.Sql,
  ): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ exists: boolean }[]>(Prisma.sql`
      WITH searchable AS (
        ${cte}
      )
      SELECT EXISTS (
        SELECT 1
        FROM searchable s
        WHERE s.document @@ ${tsQuery}
      ) AS "exists"
    `);

    return rows[0]?.exists === true;
  }

  private queryRankedArticleRows(
    cte: Prisma.Sql,
    tsQuery: Prisma.Sql,
    limitClause: Prisma.Sql,
    offset: number,
  ): Promise<SearchArticleRow[]> {
    // Raw query returns flat rows — we'll aggregate tags in JS.
    return this.prisma.$queryRaw<SearchArticleRow[]>(Prisma.sql`
      WITH searchable AS (
        ${cte}
      ),
      ranked AS (
        SELECT
          s.id,
          s."updatedAt",
          ts_rank(s.document, ${tsQuery}) AS rank
        FROM searchable s
        WHERE s.document @@ ${tsQuery}
        ORDER BY rank DESC, s."updatedAt" DESC
        ${limitClause}
        OFFSET ${offset}
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

  private toHybridMemoryResult(row: HybridArticleRow): MemoryResult {
    const result = this.toMemoryResultFromRow(
      row,
      row.tags,
      row.relevanceScore,
    );
    return defineMemoryResult({
      ...result,
      metadata: removeUndefined({
        ...result.metadata,
        hybridAlgorithm: "rrf-v1",
        hybridRawRrfScore: row.rawRrfScore,
        hybridLexicalRank: row.lexicalRank,
        hybridVectorRank: row.vectorRank,
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

function normalizeHybridFallbackReason(code: string): string {
  return /^[a-z][a-z0-9_]{0,63}$/.test(code)
    ? code
    : "transient_dependency";
}

function annotateHybridFallback(
  results: MemoryResult[],
  reason: string | undefined,
): MemoryResult[] {
  if (!reason) return results;
  return results.map((result) =>
    defineMemoryResult({
      ...result,
      metadata: {
        ...result.metadata,
        hybridFallback: true,
        hybridFallbackReason: reason,
      },
    }),
  );
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
      return "managed";
    case "draft":
      return "ephemeral";
    default:
      return "managed";
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
