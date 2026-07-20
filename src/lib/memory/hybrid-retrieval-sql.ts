import { Prisma } from "@prisma/client";

import {
  buildArticleSearchFilters,
  buildFallbackSearchTsQuery,
  buildSearchableCTE,
  buildSearchTsQuery,
  type ArticleSearchFilters,
} from "@/lib/memory/article-search";
import type { HybridCachedCandidate } from "@/lib/cache/hybrid-search-cache";

interface HybridSqlBaseInput {
  query: string;
  profileId: string;
  limit: number;
  offset: number;
  filters: ArticleSearchFilters;
}

export interface HybridMissSqlInput extends HybridSqlBaseInput {
  vectorLiteral: string;
}

export interface HybridCacheHitSqlInput extends HybridSqlBaseInput {
  expectedEpoch: string;
  candidates: HybridCachedCandidate[];
}

export function buildHybridMissSql(input: HybridMissSqlInput): Prisma.Sql {
  const search = buildSearchCtes(input.query, input.filters);
  return Prisma.sql`
    WITH
    ${search},
    profile_epoch AS MATERIALIZED (
      SELECT cache_epoch
      FROM noosphere_hybrid_c.query_profile_snapshot(${input.profileId}::uuid)
    ),
    authorized_ids AS MATERIALIZED (
      SELECT coalesce(pg_catalog.array_agg(id ORDER BY id), ARRAY[]::text[]) AS ids
      FROM authorized_base
    ),
    lexical_source AS MATERIALIZED (
      SELECT
        source.id,
        source."updatedAt",
        pg_catalog.ts_rank(source.document, effective_query.query) AS lexical_score
      FROM authorized_base AS source
      CROSS JOIN effective_query
      WHERE source.document @@ effective_query.query
      ORDER BY lexical_score DESC, source."updatedAt" DESC, source.id ASC
      LIMIT 200
    ),
    lexical_ranked AS MATERIALIZED (
      SELECT
        id,
        "updatedAt",
        pg_catalog.row_number() OVER (
          ORDER BY lexical_score DESC, "updatedAt" DESC, id ASC
        )::integer AS lexical_rank
      FROM lexical_source
    ),
    vector_source AS MATERIALIZED (
      SELECT
        candidate.article_id AS id,
        source."updatedAt",
        candidate.distance
      FROM authorized_ids
      CROSS JOIN LATERAL noosphere_hybrid_c.vector_candidates(
        ${input.profileId}::uuid,
        ${input.vectorLiteral},
        authorized_ids.ids
      ) AS candidate
      JOIN authorized_base AS source ON source.id = candidate.article_id
    ),
    vector_ranked AS MATERIALIZED (
      SELECT
        id,
        "updatedAt",
        pg_catalog.row_number() OVER (
          ORDER BY distance ASC, "updatedAt" DESC, id ASC
        )::integer AS vector_rank
      FROM vector_source
    ),
    contributions AS MATERIALIZED (
      SELECT
        id,
        "updatedAt",
        lexical_rank,
        NULL::integer AS vector_rank,
        1.0::double precision / (60 + lexical_rank) AS contribution
      FROM lexical_ranked
      UNION ALL
      SELECT
        id,
        "updatedAt",
        NULL::integer AS lexical_rank,
        vector_rank,
        1.0::double precision / (60 + vector_rank) AS contribution
      FROM vector_ranked
    ),
    fused AS MATERIALIZED (
      SELECT
        id,
        pg_catalog.max("updatedAt") AS "updatedAt",
        pg_catalog.sum(contribution)::double precision AS raw_rrf_score,
        pg_catalog.min(lexical_rank) AS lexical_rank,
        pg_catalog.min(vector_rank) AS vector_rank,
        least(
          coalesce(pg_catalog.min(lexical_rank), 2147483647),
          coalesce(pg_catalog.min(vector_rank), 2147483647)
        ) AS best_rank
      FROM contributions
      GROUP BY id
    ),
    ${buildAuthorizationCtes(Prisma.sql`fused`)},
    ${buildResultCtes(input.limit, input.offset)},
    cache_set AS MATERIALIZED (
      SELECT
        coalesce(
          pg_catalog.jsonb_agg(
            pg_catalog.jsonb_strip_nulls(
              pg_catalog.jsonb_build_object(
                'id', id,
                'rawRrfScore', raw_rrf_score,
                'lexicalRank', lexical_rank,
                'vectorRank', vector_rank
              )
            )
            ORDER BY raw_rrf_score DESC, best_rank ASC, "updatedAt" DESC, id ASC
          ),
          '[]'::jsonb
        ) AS candidates,
        pg_catalog.count(*)::integer AS fused_set_size
      FROM eligible_fused
    )
    ${buildFinalSelect(Prisma.sql`TRUE`)}
  `;
}

export function buildHybridCacheHitSql(input: HybridCacheHitSqlInput): Prisma.Sql {
  const search = buildSearchCtes(input.query, input.filters);
  const encodedCandidates = JSON.stringify(input.candidates);
  return Prisma.sql`
    WITH
    ${search},
    profile_epoch AS MATERIALIZED (
      SELECT cache_epoch
      FROM noosphere_hybrid_c.query_profile_snapshot(${input.profileId}::uuid)
    ),
    cached_input AS MATERIALIZED (
      SELECT
        candidate.id,
        candidate."rawRrfScore" AS raw_rrf_score,
        candidate."lexicalRank" AS lexical_rank,
        candidate."vectorRank" AS vector_rank,
        least(
          coalesce(candidate."lexicalRank", 2147483647),
          coalesce(candidate."vectorRank", 2147483647)
        ) AS best_rank
      FROM pg_catalog.jsonb_to_recordset(${encodedCandidates}::jsonb) AS candidate(
        id text,
        "rawRrfScore" double precision,
        "lexicalRank" integer,
        "vectorRank" integer
      )
    ),
    vector_members AS MATERIALIZED (
      SELECT member.article_id
      FROM noosphere_hybrid_c.current_vector_membership(
        ${input.profileId}::uuid,
        ARRAY(
          SELECT id FROM cached_input
          WHERE vector_rank IS NOT NULL
          ORDER BY id
        )
      ) AS member
    ),
    contribution_validation AS MATERIALIZED (
      SELECT
        cached.id,
        (
          EXISTS (SELECT 1 FROM authorized_base WHERE authorized_base.id = cached.id)
          AND (
            cached.lexical_rank IS NULL OR EXISTS (
              SELECT 1
              FROM authorized_base
              CROSS JOIN effective_query
              WHERE authorized_base.id = cached.id
                AND authorized_base.document @@ effective_query.query
            )
          )
          AND (
            cached.vector_rank IS NULL OR EXISTS (
              SELECT 1 FROM vector_members WHERE vector_members.article_id = cached.id
            )
          )
        ) AS valid
      FROM cached_input AS cached
    ),
    fused AS MATERIALIZED (
      SELECT
        cached.id,
        authorized_base."updatedAt",
        cached.raw_rrf_score,
        cached.lexical_rank,
        cached.vector_rank,
        cached.best_rank
      FROM cached_input AS cached
      JOIN authorized_base ON authorized_base.id = cached.id
    ),
    ${buildAuthorizationCtes(Prisma.sql`fused`)},
    validation_counts AS MATERIALIZED (
      SELECT
        (SELECT pg_catalog.count(*) FROM cached_input)::integer AS cached_count,
        (SELECT pg_catalog.count(*) FROM eligible_fused)::integer AS eligible_count,
        coalesce((SELECT pg_catalog.bool_and(valid) FROM contribution_validation), TRUE) AS contributions_valid,
        coalesce((SELECT cache_epoch::text = ${input.expectedEpoch} FROM profile_epoch), FALSE) AS epoch_valid
    ),
    cache_status AS MATERIALIZED (
      SELECT
        epoch_valid
        AND contributions_valid
        AND eligible_count = cached_count AS cache_valid
      FROM validation_counts
    ),
    valid_fused AS MATERIALIZED (
      SELECT eligible_fused.*
      FROM eligible_fused
      CROSS JOIN cache_status
      WHERE cache_status.cache_valid
    ),
    eligible_fused_for_results AS MATERIALIZED (
      SELECT * FROM valid_fused
    ),
    normalization AS MATERIALIZED (
      SELECT pg_catalog.max(raw_rrf_score) AS maximum_score
      FROM eligible_fused_for_results
    ),
    normalized AS MATERIALIZED (
      SELECT
        candidate.*,
        CASE
          WHEN normalization.maximum_score IS NULL OR normalization.maximum_score = 0 THEN 0
          ELSE candidate.raw_rrf_score / normalization.maximum_score
        END::double precision AS relevance_score
      FROM eligible_fused_for_results AS candidate
      CROSS JOIN normalization
    ),
    paged AS MATERIALIZED (
      SELECT *
      FROM normalized
      ORDER BY raw_rrf_score DESC, best_rank ASC, "updatedAt" DESC, id ASC
      LIMIT ${input.limit}
      OFFSET ${input.offset}
    ),
    ${buildHydratedCte()},
    cache_set AS MATERIALIZED (
      SELECT
        ${encodedCandidates}::jsonb AS candidates,
        (SELECT cached_count FROM validation_counts) AS fused_set_size
    )
    ${buildFinalSelect(Prisma.sql`(SELECT cache_valid FROM cache_status)`)}
  `;
}

function buildSearchCtes(query: string, filters: ArticleSearchFilters): Prisma.Sql {
  const authorizedBase = buildSearchableCTE(buildArticleSearchFilters(filters));
  const strict = buildSearchTsQuery(query);
  const fallback = buildFallbackSearchTsQuery(query);
  const fallbackSelect = fallback
    ? Prisma.sql`SELECT ${fallback} AS query`
    : Prisma.sql`SELECT NULL::tsquery AS query WHERE FALSE`;

  return Prisma.sql`
    authorized_base AS MATERIALIZED (
      ${authorizedBase}
    ),
    strict_query AS MATERIALIZED (
      SELECT ${strict} AS query
    ),
    strict_match_exists AS MATERIALIZED (
      SELECT EXISTS (
        SELECT 1
        FROM authorized_base
        CROSS JOIN strict_query
        WHERE authorized_base.document @@ strict_query.query
      ) AS matched
    ),
    fallback_query AS MATERIALIZED (
      ${fallbackSelect}
    ),
    effective_query AS MATERIALIZED (
      SELECT strict_query.query
      FROM strict_query
      CROSS JOIN strict_match_exists
      WHERE strict_match_exists.matched
      UNION ALL
      SELECT fallback_query.query
      FROM fallback_query
      CROSS JOIN strict_match_exists
      WHERE NOT strict_match_exists.matched
    )
  `;
}

function buildAuthorizationCtes(fused: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    lineage_locks AS MATERIALIZED (
      SELECT
        edge."articleId",
        edge."sourceGroupId",
        lineage.generation,
        edge."generationSnapshot",
        lineage."revokedAt"
      FROM "MemoryProvenanceEdge" AS edge
      JOIN "MemoryLineageState" AS lineage ON lineage.id = edge."lineageStateId"
      JOIN ${fused} AS fused_candidate ON fused_candidate.id = edge."articleId"
      ORDER BY lineage.kind::text, lineage."subjectHash", lineage.id
      FOR SHARE OF lineage
    ),
    provenance_groups AS MATERIALIZED (
      SELECT
        "articleId",
        "sourceGroupId",
        pg_catalog.bool_or(
          "revokedAt" IS NOT NULL OR generation <> "generationSnapshot"
        ) AS invalid
      FROM lineage_locks
      GROUP BY "articleId", "sourceGroupId"
    ),
    blocked_articles AS MATERIALIZED (
      SELECT "articleId"
      FROM provenance_groups
      GROUP BY "articleId"
      HAVING pg_catalog.bool_and(invalid)
    ),
    article_locks AS MATERIALIZED (
      SELECT article.id
      FROM "Article" AS article
      JOIN ${fused} AS fused_candidate ON fused_candidate.id = article.id
      JOIN authorized_base ON authorized_base.id = article.id
      LEFT JOIN blocked_articles ON blocked_articles."articleId" = article.id
      WHERE blocked_articles."articleId" IS NULL
        AND article."deletedAt" IS NULL
        AND article."recallQuarantinedAt" IS NULL
      ORDER BY article.id
      FOR SHARE OF article
    ),
    eligible_fused AS MATERIALIZED (
      SELECT fused_candidate.*
      FROM ${fused} AS fused_candidate
      JOIN article_locks ON article_locks.id = fused_candidate.id
    )
  `;
}

function buildResultCtes(limit: number, offset: number): Prisma.Sql {
  return Prisma.sql`
    normalization AS MATERIALIZED (
      SELECT pg_catalog.max(raw_rrf_score) AS maximum_score
      FROM eligible_fused
    ),
    normalized AS MATERIALIZED (
      SELECT
        candidate.*,
        CASE
          WHEN normalization.maximum_score IS NULL OR normalization.maximum_score = 0 THEN 0
          ELSE candidate.raw_rrf_score / normalization.maximum_score
        END::double precision AS relevance_score
      FROM eligible_fused AS candidate
      CROSS JOIN normalization
    ),
    paged AS MATERIALIZED (
      SELECT *
      FROM normalized
      ORDER BY raw_rrf_score DESC, best_rank ASC, "updatedAt" DESC, id ASC
      LIMIT ${limit}
      OFFSET ${offset}
    ),
    ${buildHydratedCte()}
  `;
}

function buildHydratedCte(): Prisma.Sql {
  return Prisma.sql`
    hydrated AS MATERIALIZED (
      SELECT
        paged.id,
        paged.raw_rrf_score,
        paged.lexical_rank,
        paged.vector_rank,
        paged.best_rank,
        paged.relevance_score,
        paged."updatedAt" AS rank_updated_at,
        article.title,
        article.slug,
        article.content,
        article.excerpt,
        article.status,
        article.confidence,
        article."sourceUrl",
        article."sourceType",
        article."createdAt",
        article."updatedAt",
        article."lastReviewed",
        article."authorId",
        article."authorName",
        topic.id AS topic_id,
        topic.slug AS topic_slug,
        topic.name AS topic_name,
        coalesce(
          pg_catalog.array_agg(DISTINCT tag.name ORDER BY tag.name)
            FILTER (WHERE tag.name IS NOT NULL),
          ARRAY[]::text[]
        ) AS tags
      FROM paged
      JOIN "Article" AS article ON article.id = paged.id
      JOIN "Topic" AS topic ON topic.id = article."topicId"
      LEFT JOIN "ArticleTag" AS article_tag ON article_tag."articleId" = article.id
      LEFT JOIN "Tag" AS tag ON tag.id = article_tag."tagId"
      GROUP BY
        paged.id, paged.raw_rrf_score, paged.lexical_rank, paged.vector_rank,
        paged.best_rank, paged.relevance_score, paged."updatedAt",
        article.id, topic.id
    )
  `;
}

function buildFinalSelect(cacheValid: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT
      ${cacheValid} AS cache_valid,
      profile_epoch.cache_epoch::text AS epoch,
      cache_set.candidates,
      cache_set.fused_set_size,
      hydrated.*
    FROM profile_epoch
    CROSS JOIN cache_set
    LEFT JOIN hydrated ON TRUE
    ORDER BY
      hydrated.raw_rrf_score DESC NULLS LAST,
      hydrated.best_rank ASC NULLS LAST,
      hydrated.rank_updated_at DESC NULLS LAST,
      hydrated.id ASC NULLS LAST
  `;
}
