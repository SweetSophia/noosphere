import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test, { after, mock } from "node:test";
import { NextRequest } from "next/server";
import type { Permissions, Role, PrismaClient, Prisma } from "@prisma/client";

// Use the real routes, bearer validation, permission ladder and key mutations.
// Only session lookup and persistence are stubbed; no external service is used.
// Disable Redis before dynamic route imports so the real limiter stays local.
const previousRedisUrl = process.env.REDIS_URL;
delete process.env.REDIS_URL;
let actor: Record<string, unknown> | null = null;
let expectedHash: string | undefined;
let session: { user: { id: string; name: string; role?: Role } } | null = null;
let targetId = "other-key";
let targetScopes: string[] = [];
let targetPermission: Permissions = "ADMIN";
let targetCalls: string[] = [];
type Write = { operation: string; data: Record<string, unknown> };
let writes: Write[] = [];
let authBulkWrites: Prisma.ApiKeyUpdateManyArgs[] = [];
let authLookups = 0;

function assertUsageWrite(args: Prisma.ApiKeyUpdateManyArgs, actorId: string): void {
  const lastUsedAt = args.data.lastUsedAt;
  assert.ok(lastUsedAt instanceof Date && Number.isFinite(lastUsedAt.getTime()));
  assert.deepEqual(args, {
    where: {
      id: actorId,
      OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(lastUsedAt.getTime() - 300_000) } }],
    },
    data: { lastUsedAt },
  }, "the only allowed bulk write is the validator's actor-bound, debounced usage timestamp");
}

function assertMutationWrite(actual: Write, expected: Write): void {
  assert.deepEqual(actual, expected, "mutation operation and every persisted field must match");
}

const metadata = () => ({
  id: targetId, name: "managed-key", keyPrefix: "fixture-", permissions: targetPermission,
  allowedScopes: targetScopes, agentPrincipalId: null, revokedAt: null,
  createdAt: new Date(0), lastUsedAt: null,
});
const persistence = {
  apiKey: {
    async findUnique(args: { where: { keyHash?: string; id?: string } }) {
      if (args.where.keyHash !== undefined) {
        authLookups++;
        assert.equal(args.where.keyHash, expectedHash, "real validator must hash bearer credentials");
        return actor;
      }
      targetCalls.push("snapshot");
      assert.equal(args.where.id, targetId);
      return metadata();
    },
    async updateMany(args: Prisma.ApiKeyUpdateManyArgs) {
      // Observe before asserting: even an error swallowed by a route is audited.
      authBulkWrites.push(args);
      assert.equal(typeof actor?.id, "string");
      assertUsageWrite(args, actor!.id as string);
      return { count: 1 };
    },
    async findMany() { targetCalls.push("list"); return [metadata()]; },
    async findFirst(args: { where: { id: string } }) {
      targetCalls.push("target");
      assert.equal(args.where.id, targetId);
      return metadata();
    },
    async create(args: { data: Record<string, unknown> }) {
      targetCalls.push("create"); writes.push({ operation: "create", data: args.data });
      return { ...metadata(), ...args.data, id: "created-key", keyHash: undefined };
    },
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      targetCalls.push("update"); writes.push({ operation: "update", data: args.data });
      assert.equal(args.where.id, targetId);
      return { ...metadata(), ...args.data };
    },
  },
  restrictedScope: {
    async findMany() { targetCalls.push("scopes"); return [{ tag: "team-a" }]; },
  },
  async $queryRaw() { targetCalls.push("lock"); return [metadata()]; },
  async $transaction<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    targetCalls.push("transaction"); return run(persistence as unknown as Prisma.TransactionClient);
  },
};
const cache = globalThis as unknown as { prisma?: PrismaClient };
const previous = cache.prisma;
cache.prisma = persistence as unknown as PrismaClient;
const sessionMock = mock.method(createRequire(import.meta.url)("next-auth/next"), "getServerSession", async () => session);
after(async () => {
  try {
    const { closeRedisClient } = await import("@/lib/cache/redis");
    await closeRedisClient();
  } finally {
    sessionMock.mock.restore();
    if (previous) cache.prisma = previous; else delete cache.prisma;
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedisUrl;
    assert.equal(process.env.REDIS_URL, previousRedisUrl);
  }
});

test("bulk-write oracle rejects credential changes and unconstrained usage writes", () => {
  const now = new Date();
  const valid = {
    where: { id: "actor-key", OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now.getTime() - 300_000) } }] },
    data: { lastUsedAt: now },
  };
  assertUsageWrite(valid, "actor-key");
  for (const invalid of [
    { ...valid, data: { ...valid.data, permissions: "ADMIN" } },
    { ...valid, data: { ...valid.data, allowedScopes: ["*"] } },
    { ...valid, where: { ...valid.where, id: "other-key" } },
    { ...valid, where: { id: "actor-key" } },
    { ...valid, where: { ...valid.where, OR: [{ lastUsedAt: null }] } },
    { ...valid, data: { lastUsedAt: new Date(NaN) } },
  ]) {
    assert.throws(() => assertUsageWrite(invalid as Prisma.ApiKeyUpdateManyArgs, "actor-key"));
  }
});

test("mutation oracle rejects wrong fields and operations", () => {
  const expected = { operation: "update", data: { permissions: "ADMIN" } };
  assertMutationWrite(expected, expected);
  assert.throws(() => assertMutationWrite({ operation: "update", data: { permissions: "WRITE" } }, expected));
  assert.throws(() => assertMutationWrite({ operation: "create", data: expected.data }, expected));
  assert.throws(() => assertMutationWrite({ operation: "update", data: { ...expected.data, allowedScopes: [] } }, expected));
  const revokedAt = new Date();
  assert.throws(() => assertMutationWrite({ operation: "update", data: { name: "not-revoked" } }, { operation: "update", data: { revokedAt } }));
});

type Credential = {
  name: string;
  permission?: Permissions;
  scopes?: string[];
  role?: Role;
  human?: boolean;
  invalid?: boolean;
  revoked?: boolean;
  authenticated: boolean;
  managesKeys: boolean;
};
// Expected decisions are explicit contract data, not a copy of the gate predicate.
const credentials: Credential[] = [
  { name: "full-scope ADMIN", permission: "ADMIN", scopes: ["*"], authenticated: true, managesKeys: true },
  { name: "mixed full-scope ADMIN", permission: "ADMIN", scopes: ["team-a", "*"], authenticated: true, managesKeys: true },
  { name: "public-only ADMIN", permission: "ADMIN", scopes: [], authenticated: true, managesKeys: false },
  { name: "scoped ADMIN", permission: "ADMIN", scopes: ["team-a"], authenticated: true, managesKeys: false },
  { name: "ADMIN missing scopes", permission: "ADMIN", authenticated: true, managesKeys: false },
  { name: "ADMIN near-wildcard", permission: "ADMIN", scopes: ["team-*"], authenticated: true, managesKeys: false },
  { name: "full-scope WRITE", permission: "WRITE", scopes: ["*"], authenticated: true, managesKeys: false },
  { name: "full-scope READ", permission: "READ", scopes: ["*"], authenticated: true, managesKeys: false },
  { name: "key missing permission", scopes: ["*"], authenticated: true, managesKeys: false },
  { name: "human ADMIN", human: true, role: "ADMIN", authenticated: true, managesKeys: true },
  { name: "human EDITOR", human: true, role: "EDITOR", authenticated: true, managesKeys: false },
  { name: "human VIEWER", human: true, role: "VIEWER", authenticated: true, managesKeys: false },
  { name: "human missing role", human: true, authenticated: true, managesKeys: false },
  { name: "anonymous", authenticated: false, managesKeys: false },
  { name: "unknown bearer", invalid: true, authenticated: false, managesKeys: false },
  { name: "revoked full-scope ADMIN", permission: "ADMIN", scopes: ["*"], revoked: true, authenticated: false, managesKeys: false },
];
const routes = [
  { name: "list metadata", method: "GET", collection: true, status: 200 },
  { name: "mint wildcard ADMIN", method: "POST", collection: true, status: 201, body: { name: "new-key", permissions: "ADMIN", allowedScopes: ["*"] } },
  { name: "mint default public WRITE", method: "POST", collection: true, status: 201, body: { name: "new-key" } },
  { name: "read other metadata", method: "GET", status: 200 },
  { name: "read self metadata", method: "GET", self: true, status: 200 },
  { name: "self-upgrade to wildcard", method: "PATCH", self: true, status: 200, body: { allowedScopes: ["*"] } },
  { name: "upgrade another key to wildcard", method: "PATCH", status: 200, body: { allowedScopes: ["*"] } },
  { name: "raise permission on existing wildcard key", method: "PATCH", existingWildcard: true, status: 200, body: { permissions: "ADMIN" } },
  { name: "rename another key", method: "PATCH", status: 200, body: { name: "renamed-key" } },
  { name: "revoke another key", method: "DELETE", status: 200 },
] as const;

for (const [routeIndex, route] of routes.entries()) {
  test(`global key management: ${route.name}`, async (t) => {
    assert.equal(process.env.REDIS_URL, undefined, "Redis must be disabled before handler imports");
    const collection = await import("@/app/api/keys/route");
    const detail = await import("@/app/api/keys/[id]/route");
    for (const [credentialIndex, credential] of credentials.entries()) {
      await t.test(credential.name, async () => {
        targetId = "self" in route ? "actor-key" : "other-key";
        targetScopes = "existingWildcard" in route ? ["*"] : [];
        targetPermission = "existingWildcard" in route ? "WRITE" : "ADMIN";
        targetCalls = []; writes = []; authBulkWrites = []; authLookups = 0;
        session = credential.human ? { user: { id: "human", name: "Test human", role: credential.role } } : null;
        const bearer = !credential.human && credential.name !== "anonymous";
        const raw = bearer ? `key-management-fixture-${routeIndex}-${credentialIndex}` : undefined;
        expectedHash = raw ? createHash("sha256").update(raw).digest("hex") : undefined;
        actor = credential.invalid ? null : {
          id: "actor-key", name: "Actor", permissions: credential.permission,
          allowedScopes: credential.scopes, agentPrincipalId: null,
          revokedAt: credential.revoked ? new Date(0) : null,
        };
        const collectionRoute = "collection" in route;
        const path = collectionRoute ? "/api/keys" : `/api/keys/${targetId}`;
        const request = new NextRequest(`http://localhost${path}`, {
          method: route.method,
          headers: {
            "Content-Type": "application/json",
            "x-real-ip": `198.51.${routeIndex}.${credentialIndex + 1}`,
            ...(raw ? { Authorization: `Bearer ${raw}` } : {}),
          },
          ...("body" in route ? { body: JSON.stringify(route.body) } : {}),
        });
        const startedAt = Date.now();
        const response = collectionRoute
          ? await collection[route.method as "GET" | "POST"](request)
          : await detail[route.method as "GET" | "PATCH" | "DELETE"](request, { params: Promise.resolve({ id: targetId }) });
        const finishedAt = Date.now();
        const expected = !credential.authenticated ? 401 : credential.managesKeys ? route.status : 403;
        assert.equal(response.status, expected);
        assert.equal(authBulkWrites.length, bearer && credential.authenticated ? 1 : 0, "no unobserved bulk mutation channel");
        for (const write of authBulkWrites) {
          assertUsageWrite(write, "actor-key");
          const usedAt = write.data.lastUsedAt as Date;
          assert.ok(usedAt.getTime() >= startedAt && usedAt.getTime() <= finishedAt);
        }
        if (!credential.managesKeys) {
          assert.deepEqual(targetCalls, [], "deny before any target-key, scope or transaction access");
          assert.deepEqual(writes, [], "denied actors must not mutate credentials");
          assert.deepEqual(await response.json(), { error: expected === 401 ? "Unauthorized" : "Insufficient permissions" });
        } else {
          assert.ok(targetCalls.length > 0, "allowed control must reach real handler persistence");
          assert.equal(writes.length, route.method === "GET" ? 0 : 1);
          if (route.method === "POST") {
            const body = await response.json();
            const expectedScopes = "allowedScopes" in route.body ? ["*"] : [];
            const expectedPermission = "permissions" in route.body ? "ADMIN" : "WRITE";
            assertMutationWrite(writes[0], { operation: "create", data: {
              name: "new-key", keyHash: createHash("sha256").update(body.key).digest("hex"),
              keyPrefix: body.key.slice(0, 8), permissions: expectedPermission,
              allowedScopes: expectedScopes, agentPrincipalId: null,
            } });
            assert.deepEqual(body.allowedScopes, expectedScopes);
            assert.equal(body.permissions, expectedPermission);
          } else if (route.method === "PATCH") {
            assertMutationWrite(writes[0], { operation: "update", data: route.body });
            const body = await response.json();
            assert.deepEqual(body.key.allowedScopes, "allowedScopes" in route.body ? route.body.allowedScopes : targetScopes);
            assert.equal(body.key.permissions, "permissions" in route.body ? route.body.permissions : targetPermission);
            assert.equal(body.key.name, "name" in route.body ? route.body.name : "managed-key");
            if ("existingWildcard" in route) assert.equal(targetPermission, "WRITE", "positive control must really raise permission");
          } else if (route.method === "DELETE") {
            const revokedAt = writes[0].data.revokedAt;
            assert.ok(revokedAt instanceof Date && Number.isFinite(revokedAt.getTime()));
            assert.ok(revokedAt.getTime() >= startedAt && revokedAt.getTime() <= finishedAt);
            assertMutationWrite(writes[0], { operation: "update", data: { revokedAt } });
            assert.deepEqual(await response.json(), { success: true });
          }
        }
        assert.equal(authLookups, bearer ? 1 : 0, "real authentication performs exactly the bearer lookup");
        session = null;
      });
    }
  });
}
