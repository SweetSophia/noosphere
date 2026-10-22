import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { Prisma, PrismaClient } from "@prisma/client";

// Capture the real helper's parameterized SQL at the persistence boundary.
// Recorded disposable-PostgreSQL evidence: https://github.com/SweetSophia/noosphere/issues/359.
// This suite guards generated SQL and bounded reads; it is not a concurrency test.
let statements: Prisma.Sql[] = [];
let readQueries: unknown[] = [];
let found = [{ id: "shared-tag", slug: "shared" }];
const persistence = {
  $executeRaw: async (query: Prisma.Sql) => { statements.push(query); return 1; },
  tag: { findMany: async (query: unknown) => { readQueries.push(query); return found; } },
};
const cache = globalThis as unknown as { prisma?: PrismaClient };
const previous = cache.prisma;
cache.prisma = persistence as unknown as PrismaClient;
after(() => { if (previous) cache.prisma = previous; else delete cache.prisma; });

test("attaching an existing normalized tag cannot rename shared taxonomy", async () => {
  const { buildTagConnections } = await import("@/lib/wiki");
  statements = [];
  readQueries = [];
  found = [{ id: "shared-tag", slug: "shared" }];
  assert.deepEqual(await buildTagConnections(["SHARED!", "shared"]), [{ tagId: "shared-tag" }]);
  assert.equal(statements.length, 1);
  assert.deepEqual(readQueries, [{ where: { slug: { in: ["shared"] } }, select: { id: true, slug: true } }]);
  assert.match(statements[0].text, /ON CONFLICT\s*\("slug"\)\s*DO NOTHING/);
  assert.doesNotMatch(statements[0].text, /\bUPDATE\b/i);
  assert.ok(statements[0].values.includes("SHARED!"), "new-tag display names remain parameterized");
});
test("new tags remain creatable and connections follow normalized input order", async () => {
  const { buildTagConnections } = await import("@/lib/wiki");
  statements = [];
  readQueries = [];
  found = [{ id: "second", slug: "beta" }, { id: "first", slug: "alpha" }];
  assert.deepEqual(await buildTagConnections(["Alpha", "alpha", "Beta"]), [{ tagId: "first" }, { tagId: "second" }]);
  assert.deepEqual(readQueries, [{ where: { slug: { in: ["alpha", "beta"] } }, select: { id: true, slug: true } }]);
  assert.ok(statements[0].values.includes("Alpha"));
  assert.ok(statements[0].values.includes("Beta"));
});
test("empty and unusable tag inputs perform no persistence work", async () => {
  const { buildTagConnections } = await import("@/lib/wiki");
  statements = [];
  readQueries = [];
  assert.deepEqual(await buildTagConnections([]), []);
  assert.deepEqual(await buildTagConnections(["!!!", " "]), []);
  assert.equal(statements.length, 0);
  assert.equal(readQueries.length, 0);
});
