import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

function request(path: string, init: RequestInit = {}) {
  return new NextRequest(`http://localhost${path}`, {
    ...init,
    headers: {
      "x-real-ip": `test-${crypto.randomUUID()}`,
      ...(init.headers ?? {}),
    },
  });
}

test("proxy adds security headers to wiki pages", () => {
  const response = proxy(request("/wiki/projects/example"));

  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(response.headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
  assert.match(response.headers.get("Content-Security-Policy") ?? "", /frame-ancestors 'none'/);
});

test("proxy rate-limits article mutation routes", () => {
  const headers = { "x-real-ip": `patch-${crypto.randomUUID()}` };
  let response = proxy(request("/api/articles/article-1", { method: "PATCH", headers }));

  for (let i = 1; i < 30; i += 1) {
    response = proxy(request("/api/articles/article-1", { method: "PATCH", headers }));
  }

  assert.notEqual(response.status, 429);

  const blocked = proxy(request("/api/articles/article-1", { method: "PATCH", headers }));
  assert.equal(blocked.status, 429);
});

test("proxy does not rate-limit article reads", () => {
  const headers = { "x-real-ip": `get-${crypto.randomUUID()}` };
  let response = proxy(request("/api/articles/article-1", { method: "GET", headers }));

  for (let i = 0; i < 35; i += 1) {
    response = proxy(request("/api/articles/article-1", { method: "GET", headers }));
  }

  assert.notEqual(response.status, 429);
});
