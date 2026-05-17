import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

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
