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
): Promise<MemoryResult[] | null> {
  try {
    const redis = await getReadyRedisClient();
    if (!redis) return null;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as MemoryResult[];
    }
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

    await redis.setex(cacheKey, SEARCH_CACHE_TTL_SECONDS, JSON.stringify(results));
  } catch (error) {
    console.error("Redis set error:", error);
    // Fail silently - search still works, just no caching
  }
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
