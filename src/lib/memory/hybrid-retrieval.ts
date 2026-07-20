import {
  buildHybridCacheIdentity,
  normalizeHybridQuery,
  parseHybridCacheKeyring,
  type HybridCacheIdentity,
  type HybridCacheKeyring,
  type HybridCacheResult,
  type HybridCachedCandidate,
} from "@/lib/cache/hybrid-search-cache";
import type { ArticleSearchFilters } from "@/lib/memory/article-search";

const HYBRID_MINIMUM_COVERAGE = 0.95;
const PROFILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class HybridCorrectnessError extends Error {
  readonly code: string;

  constructor(code: string, message = "Hybrid retrieval configuration or state is invalid") {
    super(message);
    this.name = "HybridCorrectnessError";
    this.code = code;
  }
}

export class HybridLexicalFallbackError extends Error {
  readonly code: string;

  constructor(code: string, message = "Hybrid retrieval may use lexical fallback") {
    super(message);
    this.name = "HybridLexicalFallbackError";
    this.code = code;
  }
}

export type HybridRetrievalConfig =
  | { enabled: false }
  | {
      enabled: true;
      profileId: string;
      cacheKeyring: HybridCacheKeyring;
    };

export interface HybridProfileSnapshot {
  profileId: string;
  providerProtocol: string;
  locality: "local" | "remote";
  modelIdentifier: string;
  modelRevision: string;
  dimensions: number;
  distanceMetric: "cosine" | "l2" | "inner_product";
  normalizationPolicy: "none" | "l2";
  documentSchemaVersion: string;
  documentNormalization: string;
  maxInputBytes: number;
  endpointIdentitySha256: string;
  profileState: "inactive" | "preparing" | "serving";
  cacheEpoch: string;
  eligibleCount: number;
  readyCount: number;
  coverage: number;
  remoteEgress: boolean;
  restrictedRemoteEgress: boolean;
}

export interface HybridRetrievalRequest {
  query: string;
  limit: number;
  offset: number;
  filters: Omit<ArticleSearchFilters, "allowedScopes">;
  allowedScopes?: string[];
  signal?: AbortSignal;
}

export interface HybridQueryResponse<Row> extends HybridCacheResult {
  cacheValid: boolean;
  rows: Row[];
}

export interface HybridRetrievalDependencies<Row> {
  loadProfile(profileId: string): Promise<HybridProfileSnapshot | null>;
  readCache(
    identity: HybridCacheIdentity,
    keyring: HybridCacheKeyring,
  ): Promise<HybridCacheResult | null>;
  hydrateCached(input: {
    request: HybridRetrievalRequest;
    profile: HybridProfileSnapshot;
    identity: HybridCacheIdentity;
    cached: HybridCacheResult;
  }): Promise<HybridQueryResponse<Row>>;
  embedQuery(input: {
    query: string;
    profile: HybridProfileSnapshot;
    signal?: AbortSignal;
  }): Promise<string>;
  searchMiss(input: {
    request: HybridRetrievalRequest;
    profile: HybridProfileSnapshot;
    vectorLiteral: string;
  }): Promise<HybridQueryResponse<Row>>;
  writeCache(
    identity: HybridCacheIdentity,
    result: HybridCacheResult,
    keyring: HybridCacheKeyring,
  ): Promise<void>;
}

export function readHybridRetrievalConfig(
  env: Readonly<Record<string, string | undefined>>,
): HybridRetrievalConfig {
  const rawFlag = env.NOOSPHERE_HYBRID_RETRIEVAL_ENABLED;
  if (rawFlag === undefined || rawFlag === "" || rawFlag === "false") {
    return { enabled: false };
  }
  if (rawFlag !== "true") {
    throw new HybridCorrectnessError(
      "feature_flag_invalid",
      "NOOSPHERE_HYBRID_RETRIEVAL_ENABLED must be exactly true or false",
    );
  }

  const profileId = env.NOOSPHERE_HYBRID_QUERY_PROFILE_ID?.toLowerCase() ?? "";
  if (!PROFILE_ID_PATTERN.test(profileId)) {
    throw new HybridCorrectnessError(
      "query_profile_invalid",
      "NOOSPHERE_HYBRID_QUERY_PROFILE_ID must be a UUID",
    );
  }

  let cacheKeyring: HybridCacheKeyring;
  try {
    cacheKeyring = parseHybridCacheKeyring({
      activeVersion: env.NOOSPHERE_HYBRID_CACHE_HMAC_ACTIVE_VERSION ?? "",
      encodedKeys: readHybridCacheKeyringJson(env),
    });
  } catch (error) {
    throw new HybridCorrectnessError(
      "cache_keyring_invalid",
      error instanceof Error ? error.message : undefined,
    );
  }

  return { enabled: true, profileId, cacheKeyring };
}

function readHybridCacheKeyringJson(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const raw = env.NOOSPHERE_HYBRID_CACHE_HMAC_KEYS;
  const encoded = env.NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64;
  if (raw && encoded) {
    throw new Error("Set only one hybrid cache HMAC keyring environment variable");
  }
  if (!encoded) return raw ?? "";
  if (
    encoded.length > 8_192 ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new Error("Hybrid cache HMAC keyring must use canonical base64");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) {
    throw new Error("Hybrid cache HMAC keyring must use canonical base64");
  }
  const json = decoded.toString("utf8");
  if (!Buffer.from(json, "utf8").equals(decoded)) {
    throw new Error("Hybrid cache HMAC keyring must be valid UTF-8");
  }
  return json;
}

export async function runHybridRetrieval<Row>(
  request: HybridRetrievalRequest,
  config: HybridRetrievalConfig,
  dependencies: HybridRetrievalDependencies<Row>,
): Promise<Row[]> {
  if (!config.enabled) {
    throw new HybridCorrectnessError("feature_disabled");
  }
  const normalizedRequest = normalizeHybridRetrievalRequest(request);
  const profile = await dependencies.loadProfile(config.profileId);
  if (!profile || profile.profileId !== config.profileId) {
    throw new HybridCorrectnessError("query_profile_missing");
  }
  validateProfileSnapshot(profile);

  if (profile.coverage < HYBRID_MINIMUM_COVERAGE) {
    throw new HybridLexicalFallbackError("insufficient_vector_coverage");
  }
  if (profile.profileState !== "serving") {
    throw new HybridCorrectnessError("query_profile_not_serving");
  }

  const identity = cacheIdentity(normalizedRequest, profile, config.cacheKeyring);
  const cached = await dependencies.readCache(identity, config.cacheKeyring);
  if (cached) {
    const hydrated = await dependencies.hydrateCached({
      request: normalizedRequest,
      profile,
      identity,
      cached,
    });
    if (hydrated.cacheValid && hydrated.epoch === identity.epoch) {
      return hydrated.rows;
    }
  }

  const vectorLiteral = await dependencies.embedQuery({
    query: normalizedRequest.query,
    profile,
    signal: normalizedRequest.signal,
  });
  const miss = await dependencies.searchMiss({
    request: normalizedRequest,
    profile,
    vectorLiteral,
  });
  if (!miss.cacheValid) {
    throw new HybridCorrectnessError("miss_query_invalid");
  }

  const missIdentity = cacheIdentity(
    normalizedRequest,
    { ...profile, cacheEpoch: miss.epoch },
    config.cacheKeyring,
  );
  await dependencies.writeCache(
    missIdentity,
    { epoch: miss.epoch, candidates: miss.candidates },
    config.cacheKeyring,
  );
  return miss.rows;
}

function normalizeHybridRetrievalRequest(
  request: HybridRetrievalRequest,
): HybridRetrievalRequest {
  const query = normalizeHybridQuery(request.query);
  if (!query) {
    throw new HybridCorrectnessError("query_empty");
  }
  return {
    ...request,
    query,
    filters: {
      topicSlug: normalizeOptionalFilter(request.filters.topicSlug),
      tagSlug: normalizeOptionalFilter(request.filters.tagSlug),
      status: normalizeOptionalFilter(request.filters.status),
      confidence: normalizeOptionalFilter(request.filters.confidence),
    },
  };
}

function normalizeOptionalFilter(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function cacheIdentity(
  request: HybridRetrievalRequest,
  profile: HybridProfileSnapshot,
  keyring: HybridCacheKeyring,
): HybridCacheIdentity {
  return buildHybridCacheIdentity(
    {
      query: request.query,
      epoch: profile.cacheEpoch,
      profileId: profile.profileId,
      documentSchema: profile.documentSchemaVersion,
      topicSlug: request.filters.topicSlug,
      tagSlug: request.filters.tagSlug,
      status: request.filters.status,
      confidence: request.filters.confidence,
      allowedScopes: request.allowedScopes,
    },
    keyring,
  );
}

function validateProfileSnapshot(profile: HybridProfileSnapshot): void {
  if (
    !Number.isSafeInteger(profile.dimensions) ||
    profile.dimensions < 1 ||
    !Number.isSafeInteger(profile.maxInputBytes) ||
    profile.maxInputBytes < 1 ||
    !Number.isFinite(profile.coverage) ||
    profile.coverage < 0 ||
    profile.coverage > 1 ||
    !/^[a-f0-9]{64}$/.test(profile.endpointIdentitySha256) ||
    !/^(?:0|[1-9][0-9]{0,19})$/.test(profile.cacheEpoch)
  ) {
    throw new HybridCorrectnessError("query_profile_malformed");
  }
  if (
    profile.providerProtocol !== "openai-compatible" ||
    !["local", "remote"].includes(profile.locality) ||
    !["cosine", "l2", "inner_product"].includes(profile.distanceMetric) ||
    !["none", "l2"].includes(profile.normalizationPolicy)
  ) {
    throw new HybridCorrectnessError("query_profile_unsupported");
  }
}

export type { HybridCachedCandidate };
