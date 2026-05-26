import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgresql://noosphere:noosphere@localhost:5432/noosphere";

test("legacy recall route aliases the canonical memory recall handler", async () => {
  const { POST: canonicalRecallPost } = await import("@/app/api/memory/recall/route");
  const { POST: legacyRecallPost } = await import("@/app/api/recall/route");

  assert.equal(typeof canonicalRecallPost, "function");
  assert.equal(legacyRecallPost, canonicalRecallPost);
});

test("plural memories recall route aliases the canonical memory recall handler", async () => {
  const { POST: canonicalRecallPost } = await import("@/app/api/memory/recall/route");
  const { POST: pluralRecallPost } = await import("@/app/api/memories/recall/route");

  assert.equal(typeof canonicalRecallPost, "function");
  assert.equal(pluralRecallPost, canonicalRecallPost);
});
