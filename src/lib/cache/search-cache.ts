import crypto from "crypto";
import { getReadyRedisClient } from "./redis";
import type { MemoryResult } from "@/lib/memory/types";

const SEARCH_CACHE_PREFIX = "recall:search:";
export const SEARCH_CACHE_VERSION_KEY = "recall:search:version";
const SEARCH_CACHE_TTL_SECONDS = 30; // 30 second TTL for search results

export interface SearchCacheKey {
  query: string;
  topicSlug?: string;
  tagSlug?: string;
  status?: string;
  confidence?: string;
  limit?: number;
  offset?: number;
  allowedScopes?: string[];
  cacheVersion?: string;
}

/**
 * Search caches deliberately contain no article text or metadata. A cache hit
 * is only a ranking hint; Noosphere must lock and rehydrate every article from
 * PostgreSQL before returning it so quarantine and revocation cannot be
 * bypassed by a stale Redis entry.
 */
export interface CachedSearchResultRef {
  id: string;
  relevanceScore?: number;
}

export function buildSearchCacheKey(options: SearchCacheKey): string {
  const normalized = {
    q: options.query.toLowerCase().trim(),
    topic: options.topicSlug ?? "",
    tag: options.tagSlug ?? "",
    status: options.status ?? "",
    confidence: options.confidence ?? "",
    limit: options.limit === undefined ? "none" : options.limit,
    offset: options.offset ?? 0,
    scopes: [...(options.allowedScopes ?? [])].sort().join(","),
    version: options.cacheVersion ?? "0",
  };
  const hash = crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  return `${SEARCH_CACHE_PREFIX}${hash}`;
}

export async function getSearchCacheVersion(): Promise<string | null> {
  try {
    const redis = await getReadyRedisClient();
    if (!redis) return null;

    return (await redis.get(SEARCH_CACHE_VERSION_KEY)) ?? "0";
  } catch (error) {
    console.error("Redis version get error:", error);
    return null;
  }
}

export async function getCachedSearchResults(
  cacheKey: string,
): Promise<CachedSearchResultRef[] | null> {
  try {
    const redis = await getReadyRedisClient();
    if (!redis) return null;
    const cached = await redis.get(cacheKey);
    if (cached) return parseCachedSearchResultRefs(cached);
    return null;
  } catch (error) {
    console.error("Redis get error:", error);
    return null; // Fail open - fall through to DB
  }
}

export async function setCachedSearchResults(
  cacheKey: string,
  results: MemoryResult[],
  expectedVersion?: string,
): Promise<void> {
  try {
    const redis = await getReadyRedisClient();
    if (!redis) return;

    if (expectedVersion !== undefined) {
      const currentVersion = (await redis.get(SEARCH_CACHE_VERSION_KEY)) ?? "0";
      if (currentVersion !== expectedVersion) {
        return;
      }
    }

    const refs = results.map(({ id, relevanceScore }) => ({
      id,
      ...(relevanceScore === undefined ? {} : { relevanceScore }),
    }));
    await redis.setex(cacheKey, SEARCH_CACHE_TTL_SECONDS, JSON.stringify(refs));
  } catch (error) {
    console.error("Redis set error:", error);
    // Fail silently - search still works, just no caching
  }
}

function parseCachedSearchResultRefs(value: string): CachedSearchResultRef[] | null {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) return null;

  const refs: CachedSearchResultRef[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) return null;
    if (
      record.relevanceScore !== undefined &&
      (typeof record.relevanceScore !== "number" ||
        !Number.isFinite(record.relevanceScore))
    ) {
      return null;
    }
    refs.push({
      id: record.id,
      ...(record.relevanceScore === undefined
        ? {}
        : { relevanceScore: record.relevanceScore as number }),
    });
  }
  return refs;
}

export const _testHooks = {
  invalidateSearchCacheCallCount: 0,
};

export async function invalidateSearchCache(): Promise<void> {
  _testHooks.invalidateSearchCacheCallCount++;
  try {
    const redis = await getReadyRedisClient();
    if (!redis) return;

    await redis.incr(SEARCH_CACHE_VERSION_KEY);
  } catch (error) {
    console.error("Redis invalidate error:", error);
    // Fail silently - cache will expire via TTL
  }
}
