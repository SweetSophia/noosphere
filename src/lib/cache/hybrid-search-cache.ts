import crypto from "node:crypto";

import {
  HYBRID_CANDIDATE_DEPTH,
  HYBRID_RRF_K,
} from "@/lib/memory/hybrid-ranking";
import { getReadyRedisClient } from "@/lib/cache/redis";

const HYBRID_CACHE_PREFIX = "recall:hybrid:v1:";
const HYBRID_CACHE_IDENTITY_DOMAIN = "noosphere-hybrid-cache-v1/identity";
const HYBRID_CACHE_SCOPES_DOMAIN = "noosphere-hybrid-cache-v1/scopes";
const HYBRID_CACHE_MAX_KEYS = 3;
const HYBRID_CACHE_MIN_KEY_BYTES = 32;
const HYBRID_CACHE_MAX_KEY_BYTES = 64;
const HYBRID_CACHE_MAX_VALUE_BYTES = 65_536;
const HYBRID_CACHE_MAX_CANDIDATES = HYBRID_CANDIDATE_DEPTH * 2;
const HYBRID_CACHE_TTL_SECONDS = 30;

export const HYBRID_CACHE_VALUE_DOMAIN = "noosphere-hybrid-cache-v1/value";

export interface HybridCacheKeyring {
  activeVersion: string;
  keys: ReadonlyMap<string, Buffer>;
}

export interface HybridCacheIdentityInput {
  query: string;
  epoch: string;
  profileId: string;
  documentSchema: string;
  topicSlug?: string;
  tagSlug?: string;
  status?: string;
  confidence?: string;
  allowedScopes?: string[];
  depth?: number;
  rrfK?: number;
}

export interface HybridCacheIdentity {
  cacheKey: string;
  keyVersion: string;
  epoch: string;
  queryHash: string;
  scopeSetMac: string;
}

export interface HybridCachedCandidate {
  id: string;
  rawRrfScore: number;
  lexicalRank?: number;
  vectorRank?: number;
}

export interface HybridCacheResult {
  epoch: string;
  candidates: HybridCachedCandidate[];
}

interface HybridCacheEnvelope extends HybridCacheResult {
  version: 1;
  keyVersion: string;
  complete: true;
  fusedSetSize: number;
  mac: string;
}

export function normalizeHybridQuery(query: string): string {
  return query
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .trim();
}

export function parseHybridCacheKeyring(input: {
  activeVersion: string;
  encodedKeys: string;
}): HybridCacheKeyring {
  if (!isKeyVersion(input.activeVersion)) {
    throw new Error("Hybrid cache active key version is invalid");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.encodedKeys);
  } catch {
    throw new Error("Hybrid cache HMAC keyring must be valid JSON");
  }
  if (!isPlainRecord(parsed)) {
    throw new Error("Hybrid cache HMAC keyring must be an object");
  }

  const entries = Object.entries(parsed);
  if (entries.length === 0 || entries.length > HYBRID_CACHE_MAX_KEYS) {
    throw new Error(`Hybrid cache HMAC keyring must contain 1-${HYBRID_CACHE_MAX_KEYS} keys`);
  }

  const keys = new Map<string, Buffer>();
  for (const [version, encoded] of entries) {
    if (!isKeyVersion(version) || typeof encoded !== "string") {
      throw new Error("Hybrid cache HMAC keyring contains an invalid entry");
    }
    const key = decodeCanonicalBase64(encoded);
    if (
      key.length < HYBRID_CACHE_MIN_KEY_BYTES ||
      key.length > HYBRID_CACHE_MAX_KEY_BYTES
    ) {
      throw new Error(
        `Hybrid cache HMAC keys must be ${HYBRID_CACHE_MIN_KEY_BYTES}-${HYBRID_CACHE_MAX_KEY_BYTES} bytes`,
      );
    }
    keys.set(version, key);
  }

  if (!keys.has(input.activeVersion)) {
    throw new Error("Hybrid cache active key version is absent from the keyring");
  }
  return { activeVersion: input.activeVersion, keys };
}

export function buildHybridCacheIdentity(
  input: HybridCacheIdentityInput,
  keyring: HybridCacheKeyring,
): HybridCacheIdentity {
  const epoch = normalizeEpoch(input.epoch);
  const queryHash = sha256Hex(normalizeHybridQuery(input.query));
  const activeKey = keyring.keys.get(keyring.activeVersion);
  if (!activeKey) {
    throw new Error("Hybrid cache active HMAC key is unavailable");
  }

  const scopes = [...new Set(input.allowedScopes ?? [])].sort();
  const scopeSetMac = hmacHex(
    activeKey,
    HYBRID_CACHE_SCOPES_DOMAIN,
    canonicalJson(scopes),
  );
  const identity = {
    version: 1,
    keyVersion: keyring.activeVersion,
    epoch,
    profileId: requireBoundedString(input.profileId, "profile ID", 128),
    documentSchema: requireBoundedString(input.documentSchema, "document schema", 128),
    algorithm: "rrf",
    algorithmVersion: 1,
    rrfK: normalizePositiveInteger(input.rrfK ?? HYBRID_RRF_K, "RRF k"),
    depth: normalizePositiveInteger(input.depth ?? HYBRID_CANDIDATE_DEPTH, "candidate depth"),
    queryHash,
    scopeSetMac,
    filters: {
      topicSlug: normalizeOptionalFilter(input.topicSlug),
      tagSlug: normalizeOptionalFilter(input.tagSlug),
      status: normalizeOptionalFilter(input.status),
      confidence: normalizeOptionalFilter(input.confidence),
    },
  };
  const digest = sha256Hex(
    `${HYBRID_CACHE_IDENTITY_DOMAIN}\0${canonicalJson(identity)}`,
  );

  return {
    cacheKey: `${HYBRID_CACHE_PREFIX}${keyring.activeVersion}:${digest}`,
    keyVersion: keyring.activeVersion,
    epoch,
    queryHash,
    scopeSetMac,
  };
}

export function createHybridCacheEnvelope(
  identity: HybridCacheIdentity,
  result: HybridCacheResult,
  keyring: HybridCacheKeyring,
): string {
  if (normalizeEpoch(result.epoch) !== identity.epoch) {
    throw new Error("Hybrid cache result epoch does not match its identity");
  }
  const candidates = validateHybridCachedCandidates(result.candidates);
  const unsigned = {
    version: 1 as const,
    keyVersion: identity.keyVersion,
    complete: true as const,
    epoch: identity.epoch,
    fusedSetSize: candidates.length,
    candidates,
  };
  const key = keyring.keys.get(identity.keyVersion);
  if (!key) throw new Error("Hybrid cache signing key is unavailable");
  const mac = valueMac(key, identity.cacheKey, unsigned);
  return canonicalJson({ ...unsigned, mac });
}

export function parseHybridCacheEnvelope(
  identity: HybridCacheIdentity,
  encoded: string,
  keyring: HybridCacheKeyring,
): HybridCacheResult | null {
  if (Buffer.byteLength(encoded, "utf8") > HYBRID_CACHE_MAX_VALUE_BYTES) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return null;
  }
  if (!isPlainRecord(parsed)) return null;

  if (
    parsed.version !== 1 ||
    parsed.complete !== true ||
    typeof parsed.keyVersion !== "string" ||
    parsed.keyVersion !== identity.keyVersion ||
    typeof parsed.epoch !== "string" ||
    parsed.epoch !== identity.epoch ||
    !Number.isInteger(parsed.fusedSetSize) ||
    typeof parsed.mac !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.mac)
  ) {
    return null;
  }

  const key = keyring.keys.get(parsed.keyVersion);
  if (!key || !Array.isArray(parsed.candidates)) return null;

  let candidates: HybridCachedCandidate[];
  try {
    candidates = validateHybridCachedCandidates(parsed.candidates);
  } catch {
    return null;
  }
  if (parsed.fusedSetSize !== candidates.length) return null;

  const unsigned = {
    version: 1 as const,
    keyVersion: parsed.keyVersion,
    complete: true as const,
    epoch: parsed.epoch,
    fusedSetSize: candidates.length,
    candidates,
  };
  const expected = valueMac(key, identity.cacheKey, unsigned);
  if (!constantTimeHexEqual(parsed.mac, expected)) return null;
  return { epoch: parsed.epoch, candidates };
}

export async function readHybridSearchCache(
  identity: HybridCacheIdentity,
  keyring: HybridCacheKeyring,
): Promise<HybridCacheResult | null> {
  try {
    const redis = await getReadyRedisClient();
    if (!redis) return null;
    const encoded = await redis.get(identity.cacheKey);
    return encoded === null
      ? null
      : parseHybridCacheEnvelope(identity, encoded, keyring);
  } catch (error) {
    logContentFreeCacheFailure("read", error);
    return null;
  }
}

export async function writeHybridSearchCache(
  identity: HybridCacheIdentity,
  result: HybridCacheResult,
  keyring: HybridCacheKeyring,
): Promise<void> {
  try {
    const redis = await getReadyRedisClient();
    if (!redis) return;
    const encoded = createHybridCacheEnvelope(identity, result, keyring);
    await redis.setex(identity.cacheKey, HYBRID_CACHE_TTL_SECONDS, encoded);
  } catch (error) {
    logContentFreeCacheFailure("write", error);
  }
}

export function validateHybridCachedCandidates(value: unknown): HybridCachedCandidate[] {
  if (!Array.isArray(value)) {
    throw new Error("Hybrid cache candidate set must be an array");
  }
  if (value.length > HYBRID_CACHE_MAX_CANDIDATES) {
    throw new Error("Hybrid cache candidate set is too large");
  }

  const seen = new Set<string>();
  let priorScore = Number.POSITIVE_INFINITY;
  return value.map((entry) => {
    if (!isPlainRecord(entry)) {
      throw new Error("Hybrid cache candidate is malformed");
    }
    const id = requireBoundedString(entry.id, "candidate ID", 256);
    if (seen.has(id)) throw new Error("Hybrid cache candidate IDs must be unique");
    seen.add(id);

    if (
      typeof entry.rawRrfScore !== "number" ||
      !Number.isFinite(entry.rawRrfScore) ||
      entry.rawRrfScore <= 0 ||
      entry.rawRrfScore > priorScore
    ) {
      throw new Error("Hybrid cache candidate score is invalid or unordered");
    }
    priorScore = entry.rawRrfScore;
    const lexicalRank = normalizeOptionalRank(entry.lexicalRank);
    const vectorRank = normalizeOptionalRank(entry.vectorRank);
    if (lexicalRank === undefined && vectorRank === undefined) {
      throw new Error("Hybrid cache candidate has no contributing rank");
    }

    return {
      id,
      rawRrfScore: entry.rawRrfScore,
      ...(lexicalRank === undefined ? {} : { lexicalRank }),
      ...(vectorRank === undefined ? {} : { vectorRank }),
    };
  });
}

function normalizeOptionalRank(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > HYBRID_CANDIDATE_DEPTH
  ) {
    throw new Error("Hybrid cache candidate rank is invalid");
  }
  return value as number;
}

function valueMac(
  key: Buffer,
  cacheKey: string,
  unsigned: Omit<HybridCacheEnvelope, "mac">,
): string {
  return hmacHex(
    key,
    HYBRID_CACHE_VALUE_DOMAIN,
    `${cacheKey}\0${canonicalJson(unsigned)}`,
  );
}

function hmacHex(key: Buffer, domain: string, value: string): string {
  return crypto.createHmac("sha256", key).update(domain).update("\0").update(value).digest("hex");
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function decodeCanonicalBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Hybrid cache HMAC keys must use canonical base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("Hybrid cache HMAC keys must use canonical base64");
  }
  return decoded;
}

function isKeyVersion(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(value);
}

function normalizeEpoch(value: string): string {
  if (!/^(?:0|[1-9][0-9]{0,19})$/.test(value)) {
    throw new Error("Hybrid cache epoch is invalid");
  }
  return value;
}

function normalizePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Hybrid cache ${name} is invalid`);
  }
  return value;
}

function normalizeOptionalFilter(value: string | undefined): string {
  return value?.trim() ?? "";
}

function requireBoundedString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`Hybrid cache ${name} is invalid`);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function logContentFreeCacheFailure(operation: "read" | "write", error: unknown): void {
  console.error("[hybrid-cache] operation failed", {
    operation,
    errorType: error instanceof Error ? error.name : "unknown",
  });
}
