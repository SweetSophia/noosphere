import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test, { after, mock } from "node:test";
import { NextRequest } from "next/server";
import type { Permissions, Role, PrismaClient } from "@prisma/client";

// Exercise the real bearer-key validator and permission ladder. Only persistence
// and session lookup are stubbed; no database or external service is contacted.
// Prisma delegates are dynamic proxies, not descriptor-backed methods. Supply
// ordinary delegates through the client's existing global cache before imports,
// so node:test can instrument only the I/O boundary in this isolated test file.
const lookup = async (_args: { where: { id?: string; slug?: string; keyHash?: string } }): Promise<unknown> => null;
const mutation = async (): Promise<unknown> => null;
const persistence = {
  apiKey: { findUnique: lookup, updateMany: async () => ({ count: 0 }) },
  tag: { findFirst: mutation, findUnique: lookup, create: mutation, update: mutation, delete: mutation },
  topic: { findUnique: lookup, count: async () => 0, update: mutation, delete: mutation },
  article: { count: async () => 0 },
  articleTag: { count: async () => 0 },
};
const globalClient = globalThis as unknown as { prisma?: PrismaClient };
const previousClient = globalClient.prisma;
globalClient.prisma = persistence as unknown as PrismaClient;
after(() => {
  if (previousClient) globalClient.prisma = previousClient;
  else delete globalClient.prisma;
});
let session: { user: { id: string; name: string; role?: Role } } | null = null;
const sessionMock = mock.method(
  createRequire(import.meta.url)("next-auth/next"),
  "getServerSession",
  async () => session,
);
after(() => sessionMock.mock.restore());

const credentials = [
  { name: "READ key", permission: "READ", level: 1 },
  { name: "WRITE key", permission: "WRITE", level: 2 },
  { name: "ADMIN key", permission: "ADMIN", level: 3 },
  { name: "VIEWER session", role: "VIEWER", level: 1 },
  { name: "EDITOR session", role: "EDITOR", level: 2 },
  { name: "ADMIN session", role: "ADMIN", level: 3 },
  { name: "session without role", level: 0, missingRole: true },
  { name: "anonymous request", level: -1 },
  { name: "unknown key", level: -1, invalidKey: true },
  { name: "revoked ADMIN key", permission: "ADMIN", level: -1, revoked: true },
] as const;

const routes = [
  { name: "POST /api/tags", method: "POST", path: "/api/tags", level: 2, status: 201, entity: "tag" },
  { name: "PATCH /api/tags/[id]", method: "PATCH", path: "/api/tags/tag-1", level: 2, status: 200, entity: "tag" },
  { name: "DELETE /api/tags/[id]", method: "DELETE", path: "/api/tags/tag-1", level: 3, status: 204, entity: "tag" },
  { name: "PATCH /api/topics/[id]", method: "PATCH", path: "/api/topics/topic-1", level: 2, status: 200, entity: "topic" },
  { name: "DELETE /api/topics/[id]", method: "DELETE", path: "/api/topics/topic-1", level: 3, status: 204, entity: "topic" },
] as const;

for (const route of routes) {
  test(`${route.name} preserves API-key and session permission boundaries`, async (t) => {
    const { checkRouteAuth } = await import("@/lib/api/auth");
    const tagRoutes = await import("@/app/api/tags/route");
    const tagIdRoutes = await import("@/app/api/tags/[id]/route");
    const topicIdRoutes = await import("@/app/api/topics/[id]/route");
    const handler = route.entity === "topic"
      ? topicIdRoutes[route.method as "PATCH" | "DELETE"]
      : route.method === "POST" ? tagRoutes.POST : tagIdRoutes[route.method];

    for (const credential of credentials) {
      await t.test(credential.name, async (c) => {
        session = "role" in credential || "missingRole" in credential
          ? { user: { id: "user-1", name: "Test user", role: "role" in credential ? credential.role : undefined } }
          : null;
        c.after(() => { session = null; });
        const rawKey = "permission" in credential || "invalidKey" in credential
          ? `taxonomy-test-${credential.name}` : undefined;
        const keyHash = rawKey ? createHash("sha256").update(rawKey).digest("hex") : undefined;
        const lookup = c.mock.method(persistence.apiKey, "findUnique", async (args: { where: { id?: string; slug?: string; keyHash?: string } }) => {
          assert.equal(args.where.keyHash, keyHash, "bearer credentials must be hashed by the real validator");
          if (!("permission" in credential)) return null;
          return {
            id: "key-1", name: "Test key", permissions: credential.permission as Permissions,
            allowedScopes: [], agentPrincipalId: null,
            revokedAt: "revoked" in credential ? new Date(0) : null,
          };
        });
        c.mock.method(persistence.apiKey, "updateMany", async () => ({ count: 1 }));
        const tag = { id: "tag-1", name: "Updated", slug: "updated" };
        const topic = { id: "topic-1", name: "Original", slug: "original", parentId: null, description: null };
        const handlerCalls = [
          c.mock.method(persistence.tag, "findFirst", async () => null),
          c.mock.method(persistence.tag, "findUnique", async (args: { where: { id?: string; slug?: string } }) => args.where.id ? tag : null),
          c.mock.method(persistence.topic, "findUnique", async (args: { where: { id?: string; slug?: string } }) => args.where.id ? topic : null),
          c.mock.method(persistence.topic, "count", async () => 0),
          c.mock.method(persistence.article, "count", async () => 0),
          c.mock.method(persistence.articleTag, "count", async () => 0),
        ];
        const mutations = [
          c.mock.method(persistence.tag, "create", async () => tag),
          c.mock.method(persistence.tag, "update", async () => tag),
          c.mock.method(persistence.tag, "delete", async () => tag),
          c.mock.method(persistence.topic, "update", async () => ({ ...topic, name: "Updated" })),
          c.mock.method(persistence.topic, "delete", async () => topic),
        ];
        const request = new NextRequest(`http://localhost${route.path}`, {
          method: route.method,
          headers: {
            "Content-Type": "application/json",
            "x-real-ip": "192.0.2.33",
            ...(rawKey ? { Authorization: `Bearer ${rawKey}` } : {}),
          },
          ...(route.method !== "DELETE" ? { body: JSON.stringify({ name: "Updated" }) } : {}),
        });
        if ("permission" in credential && !("revoked" in credential)) {
          const auth = await checkRouteAuth(request);
          assert.equal(auth.authorized, true);
          assert.equal(auth.permissions, credential.permission);
          assert.equal(auth.role, undefined, "API-key auth must not acquire a synthetic session role");
        }
        const response = await handler(request, {
          params: Promise.resolve({ id: route.entity === "tag" ? "tag-1" : "topic-1" }),
        });
        const expected = credential.level < 0 ? 401
          : credential.level < route.level ? 403 : route.status;
        assert.equal(response.status, expected);
        const mutationCount = mutations.reduce((sum, spy) => sum + spy.mock.callCount(), 0);
        assert.equal(mutationCount, expected < 400 ? 1 : 0);
        if (expected >= 400) {
          assert.equal(handlerCalls.reduce((sum, spy) => sum + spy.mock.callCount(), 0), 0,
            "denied requests must stop before taxonomy persistence access");
        }
        if (rawKey) assert.ok(lookup.mock.callCount() > 0);
      });
    }
  });
}
