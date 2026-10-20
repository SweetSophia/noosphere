import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { Prisma, PrismaClient } from "@prisma/client";

// Capture the real helper's parameterized SQL at the persistence boundary.
// Actual PostgreSQL conflict/concurrency behavior is verified separately.
let statements: Prisma.Sql[] = [];
let found = [{ id: "shared-tag", slug: "shared" }];
const persistence = {
  $executeRaw: async (query: Prisma.Sql) => { statements.push(query); return 1; },
  tag: { findMany: async () => found },
};
const cache = globalThis as unknown as { prisma?: PrismaClient };
const previous = cache.prisma;
cache.prisma = persistence as unknown as PrismaClient;
after(() => { if (previous) cache.prisma = previous; else delete cache.prisma; });

test("attaching an existing normalized tag cannot rename shared taxonomy", async () => {
  const { buildTagConnections } = await import("@/lib/wiki");
  statements = [];
  found = [{ id: "shared-tag", slug: "shared" }];
  assert.deepEqual(await buildTagConnections(["SHARED!", "shared"]), [{ tagId: "shared-tag" }]);
  assert.equal(statements.length, 1);
  assert.match(statements[0].text, /ON CONFLICT\s*\("slug"\)\s*DO NOTHING/);
  assert.doesNotMatch(statements[0].text, /\bUPDATE\b/i);
  assert.ok(statements[0].values.includes("SHARED!"), "new-tag display names remain parameterized");
});
test("new tags remain creatable and connections follow normalized input order", async () => {
  const { buildTagConnections } = await import("@/lib/wiki");
  statements = [];
  found = [{ id: "second", slug: "beta" }, { id: "first", slug: "alpha" }];
  assert.deepEqual(await buildTagConnections(["Alpha", "alpha", "Beta"]), [{ tagId: "first" }, { tagId: "second" }]);
  assert.ok(statements[0].values.includes("Alpha"));
  assert.ok(statements[0].values.includes("Beta"));
});
test("empty and unusable tag inputs perform no persistence work", async () => {
  const { buildTagConnections } = await import("@/lib/wiki");
  statements = [];
  assert.deepEqual(await buildTagConnections([]), []);
  assert.deepEqual(await buildTagConnections(["!!!", " "]), []);
  assert.equal(statements.length, 0);
});
