import { Prisma, type PrismaClient } from "@prisma/client";

import {
  normalizeHybridQuery,
  readHybridSearchCache,
  validateHybridCachedCandidates,
  writeHybridSearchCache,
  type HybridCacheResult,
} from "@/lib/cache/hybrid-search-cache";
import { withSerializableRetry } from "@/lib/memory/capture/repository";
import {
  HybridCorrectnessError,
  HybridLexicalFallbackError,
  runHybridRetrieval,
  type HybridProfileSnapshot,
  type HybridRetrievalConfig,
  type HybridRetrievalRequest,
} from "@/lib/memory/hybrid-retrieval";
import {
  buildHybridCacheHitSql,
  buildHybridMissSql,
} from "@/lib/memory/hybrid-retrieval-sql";
import {
  HYBRID_LIMITS,
  HybridProviderError,
  parseProviderConfigs,
  providerConfigJsonFromEnv,
  readBoundedInteger,
  requestEmbedding,
  vectorSqlLiteral,
} from "../../../scripts/hybrid-provider.mjs";

type HybridEnvironment = Readonly<Record<string, string | undefined>>;

type HybridProfileRow = {
  profile_id: string;
  provider_protocol: string;
  locality: string;
  model_identifier: string;
  model_revision: string;
  dimensions: number;
  distance_metric: string;
  normalization_policy: string;
  document_schema_version: string;
  document_normalization: string;
  max_input_bytes: number;
  endpoint_identity_sha256: string;
  profile_state: string;
  cache_epoch: bigint | number | string;
  eligible_count: bigint | number | string;
  ready_count: bigint | number | string;
  coverage: number | string;
  remote_egress: boolean;
  restricted_remote_egress: boolean;
};

type HybridRawQueryRow = {
  cache_valid: boolean;
  authorization_budget_valid: boolean;
  epoch: bigint | number | string;
  candidates: unknown;
  candidates_fingerprint: string;
  fused_set_size: number | string;
  id: string | null;
  raw_rrf_score: number | string | null;
  lexical_rank: number | string | null;
  vector_rank: number | string | null;
  relevance_score: number | string | null;
  title: string | null;
  slug: string | null;
  content: string | null;
  excerpt: string | null;
  status: string | null;
  confidence: string | null;
  sourceUrl: string | null;
  sourceType: string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
  lastReviewed: Date | string | null;
  authorId: string | null;
  authorName: string | null;
  topic_id: string | null;
  topic_slug: string | null;
  topic_name: string | null;
  tags: string[] | null;
};

export interface HybridArticleRow {
  id: string;
  rawRrfScore: number;
  lexicalRank?: number;
  vectorRank?: number;
  relevanceScore: number;
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
  tags: string[];
}

export async function searchHybridArticles(
  prisma: PrismaClient,
  request: HybridRetrievalRequest,
  config: HybridRetrievalConfig,
  env: HybridEnvironment = process.env,
): Promise<HybridArticleRow[]> {
  return runHybridRetrieval(request, config, {
    loadProfile: (profileId) => loadHybridProfile(prisma, profileId),
    readCache: readHybridSearchCache,
    hydrateCached: async ({ request: cachedRequest, profile, cached }) =>
      executeHybridQuery(
        prisma,
        buildHybridCacheHitSql({
          query: cachedRequest.query,
          profileId: profile.profileId,
          limit: cachedRequest.limit,
          offset: cachedRequest.offset,
          filters: {
            ...cachedRequest.filters,
            allowedScopes: cachedRequest.allowedScopes,
          },
          expectedEpoch: cached.epoch,
          candidates: cached.candidates,
        }),
      ),
    embedQuery: ({ query, profile, signal }) =>
      embedHybridQuery(prisma, query, profile, signal, env),
    searchMiss: async ({ request: missRequest, profile, vectorLiteral }) =>
      executeHybridQuery(
        prisma,
        buildHybridMissSql({
          query: missRequest.query,
          profileId: profile.profileId,
          limit: missRequest.limit,
          offset: missRequest.offset,
          filters: {
            ...missRequest.filters,
            allowedScopes: missRequest.allowedScopes,
          },
          vectorLiteral,
        }),
      ),
    writeCache: writeHybridSearchCache,
  });
}

async function loadHybridProfile(
  prisma: PrismaClient,
  profileId: string,
): Promise<HybridProfileSnapshot | null> {
  let rows: HybridProfileRow[];
  try {
    rows = await prisma.$queryRaw<HybridProfileRow[]>(Prisma.sql`
      SELECT *
      FROM noosphere_hybrid_c.query_profile_snapshot(${profileId}::uuid)
    `);
  } catch (error) {
    throw databaseCorrectnessError("query_profile_read_failed", error);
  }
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new HybridCorrectnessError("query_profile_ambiguous");
  }

  const row = rows[0];
  return {
    profileId: requireString(row.profile_id, "profile_id"),
    providerProtocol: requireString(row.provider_protocol, "provider_protocol"),
    locality: requireEnum(row.locality, ["local", "remote"], "locality"),
    modelIdentifier: requireString(row.model_identifier, "model_identifier"),
    modelRevision: requireString(row.model_revision, "model_revision"),
    dimensions: requireInteger(row.dimensions, "dimensions"),
    distanceMetric: requireEnum(
      row.distance_metric,
      ["cosine", "l2", "inner_product"],
      "distance_metric",
    ),
    normalizationPolicy: requireEnum(
      row.normalization_policy,
      ["none", "l2"],
      "normalization_policy",
    ),
    documentSchemaVersion: requireString(
      row.document_schema_version,
      "document_schema_version",
    ),
    documentNormalization: requireString(
      row.document_normalization,
      "document_normalization",
    ),
    maxInputBytes: requireInteger(row.max_input_bytes, "max_input_bytes"),
    endpointIdentitySha256: requireString(
      row.endpoint_identity_sha256,
      "endpoint_identity_sha256",
    ),
    profileState: requireEnum(
      row.profile_state,
      ["inactive", "preparing", "serving"],
      "profile_state",
    ),
    cacheEpoch: requireEpoch(row.cache_epoch),
    eligibleCount: requireNonNegativeInteger(row.eligible_count, "eligible_count"),
    readyCount: requireNonNegativeInteger(row.ready_count, "ready_count"),
    coverage: requireFiniteNumber(row.coverage, "coverage"),
    remoteEgress: requireBoolean(row.remote_egress, "remote_egress"),
    restrictedRemoteEgress: requireBoolean(
      row.restricted_remote_egress,
      "restricted_remote_egress",
    ),
  };
}

async function embedHybridQuery(
  prisma: PrismaClient,
  query: string,
  profile: HybridProfileSnapshot,
  signal: AbortSignal | undefined,
  env: HybridEnvironment,
): Promise<string> {
  if (profile.locality === "remote" && !profile.remoteEgress) {
    throw new HybridCorrectnessError("remote_query_egress_not_consented");
  }

  try {
    const providers = parseProviderConfigs(providerConfigJsonFromEnv(env));
    const provider = providers.get(profile.profileId);
    if (!provider) {
      throw new HybridCorrectnessError("query_provider_missing");
    }
    const timeoutMs = readBoundedInteger(
      env.NOOSPHERE_HYBRID_REQUEST_TIMEOUT_MS,
      "NOOSPHERE_HYBRID_REQUEST_TIMEOUT_MS",
      HYBRID_LIMITS.requestTimeoutMs,
    );
    const maxResponseBytes = readBoundedInteger(
      env.NOOSPHERE_HYBRID_MAX_RESPONSE_BYTES,
      "NOOSPHERE_HYBRID_MAX_RESPONSE_BYTES",
      HYBRID_LIMITS.responseBytes,
    );
    await authorizeHybridQueryDispatch(prisma, profile.profileId);
    const embedding = await requestEmbedding(
      {
        profile_id: profile.profileId,
        provider_protocol: profile.providerProtocol,
        locality: profile.locality,
        endpoint_identity_sha256: profile.endpointIdentitySha256,
        model_identifier: profile.modelIdentifier,
        model_revision: profile.modelRevision,
        normalization_policy: profile.normalizationPolicy,
        dimensions: profile.dimensions,
        canonical_document: canonicalizeHybridQueryDocument(
          query,
          profile.maxInputBytes,
        ),
      },
      provider,
      { signal, timeoutMs, maxResponseBytes },
    );
    validateHybridQueryEmbedding(embedding, profile);
    return vectorSqlLiteral(embedding);
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("Hybrid query cancelled", "AbortError");
    }
    if (error instanceof HybridLexicalFallbackError || error instanceof HybridCorrectnessError) {
      throw error;
    }
    if (error instanceof HybridProviderError) {
      if (error.retryable) {
        throw new HybridLexicalFallbackError(error.code);
      }
      throw new HybridCorrectnessError(error.code);
    }
    throw new HybridCorrectnessError("query_provider_config_invalid");
  }
}

async function authorizeHybridQueryDispatch(
  prisma: PrismaClient,
  profileId: string,
): Promise<void> {
  let rows: Array<{ authorized: boolean }>;
  try {
    rows = await prisma.$transaction(
      (tx) => tx.$queryRaw<Array<{ authorized: boolean }>>(Prisma.sql`
        SELECT noosphere_hybrid_c.authorize_query_dispatch(
          ${profileId}::uuid
        ) AS authorized
      `),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  } catch (error) {
    throw databaseCorrectnessError("query_dispatch_authorization_failed", error);
  }
  if (rows.length !== 1 || rows[0]?.authorized !== true) {
    throw new HybridCorrectnessError("query_dispatch_not_authorized");
  }
}

export function validateHybridQueryEmbedding(
  embedding: number[],
  profile: HybridProfileSnapshot,
): void {
  if (
    profile.distanceMetric === "cosine" &&
    embedding.every((component) => component === 0)
  ) {
    throw new HybridCorrectnessError("provider_vector_zero_norm");
  }
}

async function executeHybridQuery(
  prisma: PrismaClient,
  query: Prisma.Sql,
): Promise<{
  cacheValid: boolean;
  epoch: string;
  candidates: HybridCacheResult["candidates"];
  rows: HybridArticleRow[];
}> {
  let rawRows: HybridRawQueryRow[];
  try {
    rawRows = await withSerializableRetry(() =>
      prisma.$transaction(
        (tx) => tx.$queryRaw<HybridRawQueryRow[]>(query),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  } catch (error) {
    throw databaseCorrectnessError("hybrid_query_failed", error);
  }
  return parseHybridQueryRows(rawRows);
}

export function parseHybridQueryRows(rawRows: HybridRawQueryRow[]): {
  cacheValid: boolean;
  epoch: string;
  candidates: HybridCacheResult["candidates"];
  rows: HybridArticleRow[];
} {
  if (rawRows.length === 0) {
    throw new HybridCorrectnessError("hybrid_query_returned_no_sentinel");
  }
  const first = rawRows[0];
  const authorizationBudgetValid = requireBoolean(
    first.authorization_budget_valid,
    "authorization_budget_valid",
  );
  for (const row of rawRows) {
    if (
      requireBoolean(row.authorization_budget_valid, "authorization_budget_valid") !==
      authorizationBudgetValid
    ) {
      throw new HybridCorrectnessError("hybrid_query_metadata_inconsistent");
    }
  }
  const cacheValid = requireBoolean(first.cache_valid, "cache_valid");
  const epoch = requireEpoch(first.epoch);
  const candidatesFingerprint = requireSha256(
    first.candidates_fingerprint,
    "candidates_fingerprint",
  );
  let candidates: HybridCacheResult["candidates"];
  try {
    candidates = validateHybridCachedCandidates(first.candidates);
  } catch {
    throw new HybridCorrectnessError("hybrid_candidate_set_malformed");
  }
  if (requireInteger(first.fused_set_size, "fused_set_size") !== candidates.length) {
    throw new HybridCorrectnessError("hybrid_candidate_set_incomplete");
  }

  // candidates and fused_set_size originate in one materialized, single-row
  // cache_set CTE. Validate that bounded set once, then compare the database's
  // canonical JSONB fingerprint so repeated rows cannot silently disagree
  // without paying to parse and canonicalize the whole set for every row.
  for (const row of rawRows) {
    if (
      row.cache_valid !== cacheValid ||
      requireEpoch(row.epoch) !== epoch ||
      requireSha256(row.candidates_fingerprint, "candidates_fingerprint") !==
        candidatesFingerprint ||
      requireInteger(row.fused_set_size, "fused_set_size") !== candidates.length
    ) {
      throw new HybridCorrectnessError("hybrid_query_metadata_inconsistent");
    }
  }
  if (!authorizationBudgetValid) {
    throw new HybridLexicalFallbackError("authorized_candidate_limit_exceeded");
  }

  return {
    cacheValid,
    epoch,
    candidates,
    rows: rawRows.flatMap((row) => (row.id === null ? [] : [parseArticleRow(row)])),
  };
}

function requireSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new HybridCorrectnessError(`hybrid_${field}_invalid`);
  }
  return value;
}

function parseArticleRow(row: HybridRawQueryRow): HybridArticleRow {
  return {
    id: requireString(row.id, "id"),
    rawRrfScore: requirePositiveNumber(row.raw_rrf_score, "raw_rrf_score"),
    ...optionalRank("lexicalRank", row.lexical_rank),
    ...optionalRank("vectorRank", row.vector_rank),
    relevanceScore: requireFiniteNumber(row.relevance_score, "relevance_score"),
    title: requireString(row.title, "title"),
    slug: requireString(row.slug, "slug"),
    content: requireString(row.content, "content", true),
    excerpt: nullableString(row.excerpt, "excerpt"),
    status: requireString(row.status, "status"),
    confidence: nullableString(row.confidence, "confidence"),
    sourceUrl: nullableString(row.sourceUrl, "sourceUrl"),
    sourceType: nullableString(row.sourceType, "sourceType"),
    createdAt: requireDateLike(row.createdAt, "createdAt"),
    updatedAt: requireDateLike(row.updatedAt, "updatedAt"),
    lastReviewed: nullableDateLike(row.lastReviewed, "lastReviewed"),
    authorId: nullableString(row.authorId, "authorId"),
    authorName: nullableString(row.authorName, "authorName"),
    topicId: requireString(row.topic_id, "topic_id"),
    topicSlug: requireString(row.topic_slug, "topic_slug"),
    topicName: requireString(row.topic_name, "topic_name"),
    tags: Array.isArray(row.tags) && row.tags.every((tag) => typeof tag === "string")
      ? row.tags
      : (() => { throw new HybridCorrectnessError("hybrid_row_tags_malformed"); })(),
  };
}

export function canonicalizeHybridQueryDocument(
  query: string,
  maxBytes: number,
): Buffer {
  const value = normalizeHybridQuery(query);
  const chunks: string[] = [];
  let bytes = 0;
  for (const point of value) {
    const width = Buffer.byteLength(point, "utf8");
    if (bytes + width > maxBytes) break;
    chunks.push(point);
    bytes += width;
  }
  return Buffer.from(chunks.join(""), "utf8");
}

function databaseCorrectnessError(code: string, cause: unknown): HybridCorrectnessError {
  return new HybridCorrectnessError(
    code,
    cause instanceof Error ? `${code}: ${cause.message}` : code,
  );
}

function requireString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > 1_048_576) {
    throw new HybridCorrectnessError(`hybrid_${field}_malformed`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  return value === null ? null : requireString(value, field, true);
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new HybridCorrectnessError(`hybrid_${field}_malformed`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, field: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) {
    throw new HybridCorrectnessError(`hybrid_${field}_malformed`);
  }
  return number;
}

function requirePositiveNumber(value: unknown, field: string): number {
  const number = requireFiniteNumber(value, field);
  if (number <= 0) throw new HybridCorrectnessError(`hybrid_${field}_malformed`);
  return number;
}

function requireInteger(value: unknown, field: string): number {
  const number = requireFiniteNumber(value, field);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new HybridCorrectnessError(`hybrid_${field}_malformed`);
  }
  return number;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  return requireInteger(value, field);
}

function requireEpoch(value: unknown): string {
  const epoch = String(value);
  if (!/^(?:0|[1-9][0-9]{0,19})$/.test(epoch)) {
    throw new HybridCorrectnessError("hybrid_epoch_malformed");
  }
  return epoch;
}

function requireEnum<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  field: string,
): Value {
  if (typeof value !== "string" || !allowed.includes(value as Value)) {
    throw new HybridCorrectnessError(`hybrid_${field}_malformed`);
  }
  return value as Value;
}

function optionalRank<Key extends "lexicalRank" | "vectorRank">(
  key: Key,
  value: unknown,
): Partial<Record<Key, number>> {
  if (value === null) return {};
  const rank = requireInteger(value, key);
  if (rank < 1 || rank > 200) {
    throw new HybridCorrectnessError(`hybrid_${key}_malformed`);
  }
  return { [key]: rank } as Partial<Record<Key, number>>;
}

function requireDateLike(value: unknown, field: string): Date | string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" && !Number.isNaN(new Date(value).getTime())) return value;
  throw new HybridCorrectnessError(`hybrid_${field}_malformed`);
}

function nullableDateLike(value: unknown, field: string): Date | string | null {
  return value === null ? null : requireDateLike(value, field);
}
