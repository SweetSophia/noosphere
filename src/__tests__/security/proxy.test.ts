import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { _redisTestHooks } from "@/lib/cache/redis";
import { FakeRedisClient } from "../_helpers/fake-redis";

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

async function expectRateLimitedAfter({
  path,
  method = "GET",
  maxRequests,
  ipPrefix,
}: {
  path: string;
  method?: string;
  maxRequests: number;
  ipPrefix: string;
}) {
  const headers = { "x-real-ip": `${ipPrefix}-${crypto.randomUUID()}` };

  for (let i = 0; i < maxRequests; i += 1) {
    const response = await proxy(request(path, { method, headers }));
    // 200 here means the proxy let the request continue to the downstream handler.
    assert.equal(response.status, 200);
  }

  const blocked = await proxy(request(path, { method, headers }));
  assert.equal(blocked.status, 429);
}

test("proxy adds security headers to wiki pages", async () => {
  const response = await proxy(request("/wiki/projects/example"));

  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(response.headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
  assert.match(response.headers.get("Content-Security-Policy") ?? "", /frame-ancestors 'none'/);
});

test("proxy rate-limits article mutation routes", async () => {
  await expectRateLimitedAfter({
    path: "/api/articles/article-1",
    method: "PATCH",
    maxRequests: 30,
    ipPrefix: "patch",
  });
});

test("proxy rate-limits NextAuth callback attempts", async () => {
  await expectRateLimitedAfter({
    path: "/api/auth/callback/credentials",
    method: "POST",
    maxRequests: 10,
    ipPrefix: "auth",
  });
});

test("proxy rate-limits a representative NextAuth non-callback route", async () => {
  await expectRateLimitedAfter({
    path: "/api/auth/signin",
    maxRequests: 10,
    ipPrefix: "auth-signin",
  });
});

test("proxy rate-limits the wiki login page", async () => {
  await expectRateLimitedAfter({
    path: "/wiki/login",
    maxRequests: 10,
    ipPrefix: "login",
  });
});

test("proxy auth rate limits are isolated per IP", async () => {
  const path = "/wiki/login";
  const saturatedIpHeaders = { "x-real-ip": `auth-ip-a-${crypto.randomUUID()}` };
  const otherIpHeaders = { "x-real-ip": `auth-ip-b-${crypto.randomUUID()}` };

  for (let i = 0; i < 10; i += 1) {
    const response = await proxy(request(path, { headers: saturatedIpHeaders }));
    assert.equal(response.status, 200);
  }

  const blocked = await proxy(request(path, { headers: saturatedIpHeaders }));
  assert.equal(blocked.status, 429);

  const otherIpResponse = await proxy(request(path, { headers: otherIpHeaders }));
  assert.equal(otherIpResponse.status, 200);
});

test("proxy shares the auth rate-limit budget across login and auth API routes", async () => {
  const headers = { "x-real-ip": `auth-shared-${crypto.randomUUID()}` };

  for (let i = 0; i < 5; i += 1) {
    const response = await proxy(request("/wiki/login", { headers }));
    assert.equal(response.status, 200);
  }

  for (let i = 0; i < 5; i += 1) {
    const response = await proxy(
      request("/api/auth/callback/credentials", { method: "POST", headers })
    );
    assert.equal(response.status, 200);
  }

  const blocked = await proxy(request("/wiki/login", { headers }));
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
