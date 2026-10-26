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
  $transaction: async (fn: (tx: unknown) => unknown) => fn(persistence),
  apiKey: { findUnique: lookup, updateMany: async () => ({ count: 0 }) },
  tag: { findFirst: mutation, findUnique: lookup, create: mutation, update: mutation, delete: mutation },
  topic: { findUnique: lookup, findMany: async () => [], count: async () => 0, update: mutation, delete: mutation },
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

// Scope expectations are explicit test data, not a reimplementation of the
// route predicate; changing the production scope rule cannot change this oracle.
const credentials = [
  { name: "READ key", permission: "READ", level: 1, scopes: ["*"], expectedGlobalScope: true },
  { name: "WRITE key", permission: "WRITE", level: 2, scopes: ["*"], expectedGlobalScope: true },
  { name: "ADMIN key", permission: "ADMIN", level: 3, scopes: ["*"], expectedGlobalScope: true },
  { name: "unrestricted-only WRITE key", permission: "WRITE", level: 2, scopes: [], expectedGlobalScope: false },
  { name: "scoped WRITE key", permission: "WRITE", level: 2, scopes: ["team-a"], expectedGlobalScope: false },
  { name: "scoped ADMIN key", permission: "ADMIN", level: 3, scopes: ["team-a"], expectedGlobalScope: false },
  { name: "unrestricted-only ADMIN key", permission: "ADMIN", level: 3, scopes: [], expectedGlobalScope: false },
  { name: "WRITE key without scopes", permission: "WRITE", level: 2, scopes: undefined, expectedGlobalScope: false },
  { name: "ADMIN key without scopes", permission: "ADMIN", level: 3, scopes: undefined, expectedGlobalScope: false },
  { name: "mixed wildcard WRITE key", permission: "WRITE", level: 2, scopes: ["team-a", "*"], expectedGlobalScope: true },
  { name: "key without permission", permission: undefined, level: 0, scopes: ["*"], expectedGlobalScope: true },
  { name: "VIEWER session", role: "VIEWER", level: 1, expectedGlobalScope: true },
  { name: "EDITOR session", role: "EDITOR", level: 2, expectedGlobalScope: true },
  { name: "ADMIN session", role: "ADMIN", level: 3, expectedGlobalScope: true },
  { name: "session without role", level: 0, missingRole: true, expectedGlobalScope: true },
  { name: "anonymous request", level: -1, expectedGlobalScope: false },
  { name: "unknown key", level: -1, invalidKey: true, expectedGlobalScope: false },
  { name: "revoked ADMIN key", permission: "ADMIN", level: -1, revoked: true, expectedGlobalScope: false },
] as const;

const routes = [
  { name: "POST /api/tags", method: "POST", path: "/api/tags", level: 2, status: 201, entity: "tag" },
  { name: "PATCH /api/tags/[id]", method: "PATCH", path: "/api/tags/tag-1", level: 2, status: 200, entity: "tag" },
  { name: "DELETE /api/tags/[id]", method: "DELETE", path: "/api/tags/tag-1", level: 3, status: 204, entity: "tag" },
  { name: "PATCH /api/topics/[id]", method: "PATCH", path: "/api/topics/topic-1", level: 2, status: 200, entity: "topic" },
  { name: "PATCH /api/topics/[id] move", method: "PATCH", path: "/api/topics/topic-1", level: 2, status: 200, entity: "topic", body: { parentId: "parent-1" } },
  { name: "PATCH /api/topics/[id] description", method: "PATCH", path: "/api/topics/topic-1", level: 2, status: 200, entity: "topic", body: { description: "Updated description" } },
  { name: "DELETE /api/topics/[id]", method: "DELETE", path: "/api/topics/topic-1", level: 3, status: 204, entity: "topic" },
] as const;

for (const [routeIndex, route] of routes.entries()) {
  test(`${route.name} preserves API-key and session permission boundaries`, async (t) => {
    const { checkRouteAuth } = await import("@/lib/api/auth");
    const tagRoutes = await import("@/app/api/tags/route");
    const tagIdRoutes = await import("@/app/api/tags/[id]/route");
    const topicIdRoutes = await import("@/app/api/topics/[id]/route");
    const handler = route.entity === "topic"
      ? topicIdRoutes[route.method as "PATCH" | "DELETE"]
      : route.method === "POST" ? tagRoutes.POST : tagIdRoutes[route.method];

    for (const [credentialIndex, credential] of credentials.entries()) {
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
            allowedScopes: "scopes" in credential ? credential.scopes : [], agentPrincipalId: null,
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
          c.mock.method(persistence.topic, "findMany", async () => []),
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
            "x-real-ip": `192.0.2.${routeIndex * 20 + credentialIndex + 1}`,
            ...(rawKey ? { Authorization: `Bearer ${rawKey}` } : {}),
          },
          ...(route.method !== "DELETE" ? { body: JSON.stringify("body" in route ? route.body : { name: "Updated" }) } : {}),
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
        // Existing shared taxonomy can affect articles outside this key's
        // scopes. Deny before any lookup, including keys with ADMIN permission.
        // New tag creation deliberately retains its existing WRITE policy.
        const lacksGlobalScope = route.method !== "POST" && "permission" in credential
          && !credential.expectedGlobalScope;
        const expected = credential.level < 0 ? 401
          : credential.level < route.level || lacksGlobalScope ? 403 : route.status;
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

for (const [code, expected] of [["P2003", 409], ["P2025", 404]] as const) {
  test(`tag DELETE maps a post-check ${code} race to HTTP ${expected}`, async (t) => {
    session = { user: { id: "user-1", name: "Admin", role: "ADMIN" } };
    t.after(() => { session = null; });
    t.mock.method(persistence.tag, "findUnique", async () => ({ id: "tag-1", name: "Tag", slug: "tag" }));
    t.mock.method(persistence.articleTag, "count", async () => 0);
    t.mock.method(persistence.tag, "delete", async () => { throw Object.assign(new Error("fixture"), { code }); });
    const { DELETE } = await import("@/app/api/tags/[id]/route");
    const response = await DELETE(new NextRequest("http://localhost/api/tags/tag-1", {
      method: "DELETE", headers: { "x-real-ip": "192.0.2.250" },
    }), { params: Promise.resolve({ id: "tag-1" }) });
    assert.equal(response.status, expected);
  });
}

test("seed child creation and attachment are one serializable operation", async () => {
  const { TaxonomyConflict, upsertTopicWithParentSafely } = await import("@/lib/taxonomy");
  let attempts = 0;
  const client = {
    $transaction: async (fn: (tx: unknown) => unknown, options: { isolationLevel: string }) => {
      attempts++;
      assert.equal(options.isolationLevel, "Serializable");
      return fn({
        topic: {
          findUnique: async ({ where }: { where: { id?: string; slug?: string } }) =>
            where.id === "parent" ? { id: where.id, parentId: null } : null,
          create: async ({ data }: { data: { parentId: string; slug: string } }) => ({
            id: "child",
            ...data,
          }),
        },
      });
    },
  } as unknown as PrismaClient;
  const child = await upsertTopicWithParentSafely({
    name: "Child", slug: "child", description: null, parentId: "parent",
  }, client);
  assert.equal(child.parentId, "parent");
  assert.equal(attempts, 1);

  const missingParent = {
    $transaction: async (fn: (tx: unknown) => unknown) => fn({
      topic: {
        findUnique: async () => null,
        create: async () => { throw new Error("must not create without a parent"); },
      },
    }),
  } as unknown as PrismaClient;
  await assert.rejects(
    upsertTopicWithParentSafely({ name: "Child", slug: "child", parentId: "missing" }, missingParent),
    (error: unknown) => error instanceof TaxonomyConflict && error.status === 400,
  );
});

test("topic serialization retries are bounded and do not swallow unrelated failures", async () => {
  const { TaxonomyConflict, updateTopicSafely } = await import("@/lib/taxonomy");
  for (const error of [
    Object.assign(new Error("fixture"), { code: "P2034" }),
    Object.assign(new Error("fixture"), { code: "P2010", meta: { code: "40001" } }),
    Object.assign(new Error("fixture"), { code: "P2010", meta: { driverAdapterError: "deadlock 40P01" } }),
    Object.assign(new Error("fixture"), {
      code: "P2010",
      meta: { driverAdapterError: { kind: "TransactionWriteConflict", originalCode: "40001" } },
    }),
    Object.assign(new Error("fixture"), {
      code: "P2010",
      meta: { cause: { originalCode: "40P01" } },
    }),
    Object.assign(new Error("database failure 40001"), { code: "P2010" }),
    Object.assign(new Error("fixture"), { name: "DriverAdapterError", cause: { kind: "TransactionWriteConflict", originalCode: "40001" } }),
    Object.assign(new Error("fixture"), { name: "DriverAdapterError", cause: { kind: "TransactionWriteConflict", originalCode: "40P01" } }),
  ]) {
    let attempts = 0;
    const client = { $transaction: async (_fn: unknown, options: { isolationLevel: string }) => {
      attempts++;
      assert.equal(options.isolationLevel, "Serializable");
      throw error;
    } } as unknown as PrismaClient;
    await assert.rejects(updateTopicSafely("topic", {}, client), (e: unknown) => e instanceof TaxonomyConflict && e.status === 409);
    assert.equal(attempts, 3);
  }
  for (const error of [new Error("unrelated"), Object.assign(new Error("syntax 42601"), { code: "P2010", meta: { code: "42601" } }), Object.assign(new Error("bad query"), { name: "DriverAdapterError", cause: { kind: "Unknown", originalCode: "42601" } })]) {
    let attempts = 0;
    const client = { $transaction: async () => { attempts++; throw error; } } as unknown as PrismaClient;
    await assert.rejects(updateTopicSafely("topic", {}, client), (e: unknown) => e === error);
    assert.equal(attempts, 1);
  }
});
