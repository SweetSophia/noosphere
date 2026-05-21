import crypto from "crypto";
import { getRedisClient } from "./redis";
import type { MemoryResult } from "@/lib/memory/types";

const SEARCH_CACHE_PREFIX = "recall:search:";
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
}

export function buildSearchCacheKey(options: SearchCacheKey): string {
  const normalized = {
    q: options.query.toLowerCase().trim(),
    topic: options.topicSlug ?? "",
    tag: options.tagSlug ?? "",
    status: options.status ?? "",
    confidence: options.confidence ?? "",
    limit: options.limit ?? 0,
    offset: options.offset ?? 0,
    scopes: (options.allowedScopes ?? []).sort().join(","),
  };
  const hash = crypto.createHash("md5").update(JSON.stringify(normalized)).digest("hex");
  return `${SEARCH_CACHE_PREFIX}${hash}`;
}

export async function getCachedSearchResults(
  cacheKey: string,
): Promise<MemoryResult[] | null> {
  try {
    const redis = getRedisClient();
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
): Promise<void> {
  try {
    const redis = getRedisClient();
    if (!redis) return;
    await redis.setex(cacheKey, SEARCH_CACHE_TTL_SECONDS, JSON.stringify(results));
  } catch (error) {
    console.error("Redis set error:", error);
    // Fail silently - search still works, just no caching
  }
}

export async function invalidateSearchCache(): Promise<void> {
  try {
    const redis = getRedisClient();
    if (!redis) return;

    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        `${SEARCH_CACHE_PREFIX}*`,
        "COUNT",
        100,
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== "0");
  } catch (error) {
    console.error("Redis invalidate error:", error);
    // Fail silently - cache will expire via TTL
  }
}
