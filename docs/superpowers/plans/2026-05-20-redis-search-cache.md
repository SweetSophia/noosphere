# Redis Search Cache Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Add Redis caching layer to reduce recall latency from 100-200ms to 5-20ms for cached queries.

**Architecture:** Cache-aside pattern using Redis. On search, check cache first; on cache miss, query DB and populate cache. On article CUD, invalidate all search caches (full invalidation since writes are infrequent relative to reads).

**Tech Stack:** ioredis (async Redis client), existing Prisma setup, existing docker-compose

---

## File Structure

```
src/lib/cache/
  redis.ts          # Redis client singleton
  search-cache.ts   # Cache-aside wrapper for search results

src/lib/memory/
  noosphere.ts      # MODIFY: integrate search cache
  api/save.ts       # MODIFY: invalidate cache on save

docker-compose.yml  # MODIFY: add Redis service
.env.example        # MODIFY: add REDIS_URL
package.json        # MODIFY: add ioredis
```

---

## Tasks

### Task 1: Add ioredis dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add ioredis to dependencies**

Run: `npm install ioredis`
Expected: ioredis added to node_modules and package.json updated

### Task 2: Create Redis client singleton

**Files:**
- Create: `src/lib/cache/redis.ts`

```typescript
import Redis from "ioredis";
import { prisma as defaultPrisma } from "@/lib/prisma";

let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (redisClient) {
    return redisClient;
  }

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL environment variable is not set");
  }

  redisClient = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      if (times > 3) {
        return null; // Stop retrying
      }
      return Math.min(times * 100, 3000);
    },
    lazyConnect: true,
  });

  redisClient.on("error", (err) => {
    console.error("Redis client error:", err);
  });

  return redisClient;
}

export async function closeRedisClient(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}
```

- [ ] **Step 1: Create the Redis client file**
- [ ] **Step 2: Commit**

```bash
git add src/lib/cache/redis.ts
git commit -m "feat: add Redis client singleton"
```

### Task 3: Create search cache wrapper

**Files:**
- Create: `src/lib/cache/search-cache.ts`

```typescript
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
    await redis.setex(cacheKey, SEARCH_CACHE_TTL_SECONDS, JSON.stringify(results));
  } catch (error) {
    console.error("Redis set error:", error);
    // Fail silently - search still works, just no caching
  }
}

export async function invalidateSearchCache(): Promise<void> {
  try {
    const redis = getRedisClient();
    const keys = await redis.keys(`${SEARCH_CACHE_PREFIX}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch (error) {
    console.error("Redis invalidate error:", error);
    // Fail silently - cache will expire via TTL
  }
}
```

- [ ] **Step 1: Create the search cache wrapper file**
- [ ] **Step 2: Commit**

```bash
git add src/lib/cache/search-cache.ts
git commit -m "feat: add search cache wrapper with cache-aside pattern"
```

### Task 4: Integrate cache into NoosphereProvider.search()

**Files:**
- Modify: `src/lib/memory/noosphere.ts` (around line 108-138, the search method)

- [ ] **Step 1: Add import for cache functions**

Add to the imports at the top of noosphere.ts:
```typescript
import {
  buildSearchCacheKey,
  getCachedSearchResults,
  setCachedSearchResults,
} from "@/lib/cache/search-cache";
```

- [ ] **Step 2: Modify the search() method to check cache first**

In the `search` method (lines 108-138), after line 136 (before `return articles;`), add cache logic:

```typescript
// Check cache first
const cacheKey = buildSearchCacheKey({
  query: normalizedQuery,
  topicSlug: metadata.topicSlug ?? options.scope,
  tagSlug: metadata.tagSlug,
  status: metadata.status,
  confidence: metadata.confidence,
  limit,
  offset: normalizeOffset(metadata.offset),
  allowedScopes: this.allowedScopes,
});

const cachedResults = await getCachedSearchResults(cacheKey);
if (cachedResults !== null) {
  return cachedResults;
}

// Cache miss - proceed with database query
const articles = await this.searchArticles(normalizedQuery, {
  limit,
  offset: normalizeOffset(metadata.offset),
  topicSlug: metadata.topicSlug ?? options.scope,
  tagSlug: metadata.tagSlug,
  status: metadata.status,
  confidence: metadata.confidence,
  allowedScopes: this.allowedScopes,
});

// Populate cache
await setCachedSearchResults(cacheKey, articles);

return articles;
```

Replace the existing `const articles = await this.searchArticles(...)` and `return articles;` lines with this new block.

- [ ] **Step 3: Commit**

```bash
git add src/lib/memory/noosphere.ts
git commit -m "feat: integrate search cache into NoosphereProvider"
```

### Task 5: Add cache invalidation to save flow

**Files:**
- Modify: `src/lib/memory/api/save.ts`

- [ ] **Step 1: Add import at the top of save.ts**

```typescript
import { invalidateSearchCache } from "@/lib/cache/search-cache";
```

- [ ] **Step 2: Call invalidation after successful save**

In `executeMemorySaveRequest` (around line 132-143), after successful save:

```typescript
const writer = options.writer ?? (await getDefaultMemorySaveWriter());
const candidate = await writer.saveCandidate(validation.input);

// Invalidate search cache on successful save
await invalidateSearchCache().catch((err) => {
  console.error("Failed to invalidate search cache:", err);
});

return {
  status: 201,
  body: {
    success: true,
    candidate,
    strippedBlocks: validation.input.strippedBlocks,
  },
};
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/memory/api/save.ts
git commit -m "feat: invalidate search cache on article save"
```

### Task 6: Add Redis to docker-compose.yml

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Add Redis service after the db service (around line 61)**

```yaml
  redis:
    image: redis:7-alpine
    container_name: noosphere-redis
    restart: unless-stopped
    ports:
      - "127.0.0.1:6379:6379"
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
```

- [ ] **Step 2: Add redis_data volume (around line 63)**

```yaml
volumes:
  postgres_data:
    driver: local
  redis_data:
    driver: local
```

- [ ] **Step 3: Add REDIS_URL to app environment and depends_on**

In the `app` service, add:
```yaml
environment:
  # ... existing env vars ...
  REDIS_URL: redis://redis:6379
depends_on:
  db:
    condition: service_healthy
  redis:
    condition: service_healthy
```

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: add Redis service to docker-compose"
```

### Task 7: Add REDIS_URL to .env.example

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add Redis URL after database section**

```bash
# ────────────────────────────────────────────
# Redis
# ────────────────────────────────────────────
REDIS_URL="redis://localhost:6379"
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: add REDIS_URL to .env.example"
```

### Task 8: Install dependencies and test

**Files:**
- Modify: `package.json` (auto-generated by npm install)

- [ ] **Step 1: Install ioredis**

Run: `npm install ioredis`
Expected: ioredis added to package.json

- [ ] **Step 2: Run prisma generate (required per AGENTS.md)**

Run: `npx prisma generate`
Expected: Prisma client generated successfully

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Run lint**

Run: `npm run lint`
Expected: No lint errors

- [ ] **Step 5: Commit dependencies**

```bash
git add package.json package-lock.json
git commit -m "deps: add ioredis for Redis caching"
```

### Task 9: Create PR

- [ ] **Step 1: Push branch**

Run: `git push -u origin redis-search-cache`
Expected: Branch pushed successfully

- [ ] **Step 2: Create PR**

Run: `gh pr create --title "feat: add Redis search cache for faster recall" --body "## Summary
- Add Redis client singleton for caching
- Implement cache-aside pattern for recall search results
- Invalidate search cache on article save
- Add Redis service to docker-compose
- Cache TTL: 30 seconds

## Latency improvement
- Before: 100-200ms per recall (DB FTS query)
- After: 5-20ms for cached queries (Redis lookup)

## Testing
- [ ] Recall latency measurably improved with Redis running
- [ ] New articles appear in recall results after cache TTL expires
- [ ] docker-compose up starts Redis successfully"`
Expected: PR created successfully

---

## Self-Review Checklist

- [ ] All imports use correct paths
- [ ] Redis client handles connection errors gracefully (fail open)
- [ ] Cache invalidation happens after successful save only
- [ ] TTL of 30 seconds is appropriate for the use case
- [ ] REDIS_URL is optional at build time (app works without Redis, just slower)
- [ ] All new files have proper TypeScript types

---

## Alternative Considerations (not implemented)

1. **Smart invalidation by topic/tag** - Would require tracking cache key registry. Not worth complexity given low write volume.

2. **Article-level caching** - Could cache individual articles by ID. Not implemented since recall already returns full article data in search.

3. **Cache warming** - Pre-populate cache on startup. Not implemented since cold cache is acceptable.

---

## Verification

After deployment, verify:
1. `docker-compose up -d` starts Redis container
2. `REDIS_URL=redis://localhost:6379 npm run dev` connects to Redis
3. First recall request hits DB (cache miss)
4. Second recall request with same query hits Redis (cache hit)
5. After saving new article, cache is invalidated
6. Subsequent recall finds the new article