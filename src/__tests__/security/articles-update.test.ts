import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { NextRequest } from "next/server";
import { _redisTestHooks } from "@/lib/cache/redis";
import { FakeRedisClient } from "../_helpers/fake-redis";

test.beforeEach(() => {
  _redisTestHooks.setClientForTesting(new FakeRedisClient() as never);
});

test.afterEach(() => {
  _redisTestHooks.reset();
});

function requireDatabaseUrl(): void {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable must be set for tests");
  }
}

function patchRequest(ip: string): NextRequest {
  return new NextRequest("http://localhost/api/articles/article-1", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "x-real-ip": ip,
    },
    body: JSON.stringify({ title: "Unauthorized update attempt" }),
  });
}

test("PATCH /api/articles/[id] rate-limits before auth work", async () => {
  // The route imports Prisma-backed auth helpers, but this assertion never
  // reaches DB work: the limiter runs first and unauthenticated requests stop
  // at 401 until the limiter returns 429.
  requireDatabaseUrl();
  const originalConsoleError = console.error;

  try {
    const { PATCH } = await import("@/app/api/articles/[id]/route");
    const ip = `article-patch-${crypto.randomUUID()}`;
    console.error = (...args: Parameters<typeof console.error>) => {
      const [prefix] = args;
      if (prefix === "[Auth] Session error:") {
        return;
      }
      originalConsoleError(...args);
    };

    for (let i = 0; i < 30; i += 1) {
      const response = await PATCH(patchRequest(ip), {
        params: Promise.resolve({ id: "article-1" }),
      });
      assert.equal(response.status, 401);
    }

    const blocked = await PATCH(patchRequest(ip), {
      params: Promise.resolve({ id: "article-1" }),
    });
    assert.equal(blocked.status, 429);
  } finally {
    console.error = originalConsoleError;
  }
});

test("PATCH /api/articles/[id] uses the bounded JSON parser", async () => {
  const source = await readFile(
    path.join(process.cwd(), "src/app/api/articles/[id]/route.ts"),
    "utf8",
  );

  assert.doesNotMatch(source, /request\.json\s*\(/);
  assert.match(
    source,
    /readBoundedJsonObject<[^>]+>\s*\(\s*request,\s*ARTICLE_JSON_BODY_MAX_BYTES,\s*\)/,
  );
});
