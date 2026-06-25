import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { _redisTestHooks } from "@/lib/cache/redis";

class FakeRedisClient {
  status = "wait";
  private readonly sortedSets = new Map<string, Array<{ score: number; member: string }>>();

  async connect() {
    this.status = "ready";
  }

  disconnect() {
    this.status = "end";
  }

  zremrangebyscore(key: string, min: string, max: string): number {
    this.assertReady();
    const entries = this.sortedSets.get(key) ?? [];
    const minScore = min === "-inf" ? Number.NEGATIVE_INFINITY : Number(min);
    const maxScore = Number(max);
    const retained = entries.filter((entry) => entry.score < minScore || entry.score > maxScore);
    this.sortedSets.set(key, retained);
    return entries.length - retained.length;
  }

  zcard(key: string): number {
    this.assertReady();
    return this.sortedSets.get(key)?.length ?? 0;
  }

  zadd(key: string, score: number, member: string): number {
    this.assertReady();
    const entries = this.sortedSets.get(key) ?? [];
    if (entries.some((entry) => entry.member === member)) {
      return 0;
    }
    entries.push({ score, member });
    this.sortedSets.set(key, entries);
    return 1;
  }

  expire() {
    this.assertReady();
    return 1;
  }

  private assertReady() {
    if (this.status !== "ready") {
      throw new Error("Redis command executed before client was ready");
    }
  }

  pipeline() {
    const commands: Array<{ method: "zremrangebyscore" | "zcard" | "zadd" | "expire"; args: unknown[] }> = [];

    const pipeline = {
      zremrangebyscore: (key: string, min: string, max: string) => {
        commands.push({ method: "zremrangebyscore", args: [key, min, max] });
        return pipeline;
      },
      zcard: (key: string) => {
        commands.push({ method: "zcard", args: [key] });
        return pipeline;
      },
      zadd: (key: string, score: number, member: string) => {
        commands.push({ method: "zadd", args: [key, score, member] });
        return pipeline;
      },
      expire: (key: string, seconds: number) => {
        commands.push({ method: "expire", args: [key, seconds] });
        return pipeline;
      },
      exec: async () => commands.map((command) => {
        try {
          let result: number;
          if (command.method === "zremrangebyscore") {
            const [key, min, max] = command.args as [string, string, string];
            result = this.zremrangebyscore(key, min, max);
          } else if (command.method === "zcard") {
            const [key] = command.args as [string];
            result = this.zcard(key);
          } else if (command.method === "zadd") {
            const [key, score, member] = command.args as [string, number, string];
            result = this.zadd(key, score, member);
          } else {
            result = this.expire();
          }
          return [null, result] as [null, unknown];
        } catch (error) {
          return [error as Error, null] as [Error, null];
        }
      }),
    };

    return pipeline;
  }
}

test.beforeEach(() => {
  _redisTestHooks.setClientForTesting(new FakeRedisClient() as never);
});

test.afterEach(() => {
  _redisTestHooks.reset();
});

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-real-ip", headers.get("x-real-ip") ?? `test-${crypto.randomUUID()}`);
  const { headers: _headers, signal, ...requestInit } = init;

  return new NextRequest(`http://localhost${path}`, {
    ...requestInit,
    signal: signal ?? undefined,
    headers,
  });
}

test("proxy adds security headers to wiki pages", async () => {
  const response = await proxy(request("/wiki/projects/example"));

  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(response.headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
  assert.match(response.headers.get("Content-Security-Policy") ?? "", /frame-ancestors 'none'/);
});

test("proxy rate-limits article mutation routes", async () => {
  const headers = { "x-real-ip": `patch-${crypto.randomUUID()}` };
  let response = await proxy(request("/api/articles/article-1", { method: "PATCH", headers }));

  for (let i = 1; i < 30; i += 1) {
    response = await proxy(request("/api/articles/article-1", { method: "PATCH", headers }));
  }

  assert.notEqual(response.status, 429);

  const blocked = await proxy(request("/api/articles/article-1", { method: "PATCH", headers }));
  assert.equal(blocked.status, 429);
});

test("proxy does not rate-limit article reads", async () => {
  const headers = { "x-real-ip": `get-${crypto.randomUUID()}` };
  let response = await proxy(request("/api/articles/article-1", { method: "GET", headers }));

  for (let i = 0; i < 35; i += 1) {
    response = await proxy(request("/api/articles/article-1", { method: "GET", headers }));
  }

  assert.notEqual(response.status, 429);
});

test("proxy redirects unauthenticated admin pages to login with callback", async () => {
  const response = await proxy(request("/wiki/admin/keys?tab=active"));
  const location = response.headers.get("location");

  assert.equal(response.status, 307);
  assert.ok(location);

  const redirect = new URL(location);
  assert.equal(redirect.pathname, "/wiki/login");
  assert.equal(redirect.searchParams.get("callbackUrl"), "/wiki/admin/keys?tab=active");
});

test("proxy does not treat similarly named wiki paths as admin pages", async () => {
  const response = await proxy(request("/wiki/administrator"));

  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
});
