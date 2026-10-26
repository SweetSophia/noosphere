import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { TaxonomyConflict, updateTopicSafely } from "@/lib/taxonomy";

after(async () => {
  await prisma.$disconnect();
  await (globalThis as unknown as { pool?: { end(): Promise<void> } }).pool?.end();
});

// This suite runs only against the CI/disposable test database, as the app role.
// Rendezvous both validated moves before either writes; elapsed timing is never
// used to decide whether the vulnerable interleaving actually happened.
function rendezvous() {
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return async () => {
    if (++arrived === 2) release();
    await ready;
  };
}

test("opposing topic moves cannot both commit after concurrent validation", { timeout: 20000 }, async () => {
  const prefix = `taxonomy-${randomUUID()}`;
  const a = await prisma.topic.create({ data: { name: "A", slug: `${prefix}-a` } });
  const b = await prisma.topic.create({ data: { name: "B", slug: `${prefix}-b` } });
  const wait = rendezvous();
  let firstUpdates = 0;
  const client = prisma.$extends({ query: { topic: {
    async update({ args, query }) {
      if (firstUpdates++ < 2) await wait();
      return query(args);
    },
  } } }) as unknown as PrismaClient;
  try {
    const result = await Promise.allSettled([
      updateTopicSafely(a.id, { parentId: b.id }, client),
      updateTopicSafely(b.id, { parentId: a.id }, client),
    ]);
    assert.equal(firstUpdates >= 2, true, "both moves must reach the controlled interleaving");
    assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = result.find((r) => r.status === "rejected");
    assert.ok(rejected?.status === "rejected" && rejected.reason instanceof TaxonomyConflict, JSON.stringify(rejected));
    assert.equal(rejected.reason.status, 400, "serialization retry must revalidate and reject the cycle");
    const rows = await prisma.topic.findMany({ where: { id: { in: [a.id, b.id] } } });
    assert.equal(rows.filter((r) => r.parentId !== null).length, 1);
  } finally {
    await prisma.topic.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { parentId: null } });
    await prisma.topic.deleteMany({ where: { id: { in: [a.id, b.id] } } });
  }
});

test("topic moves terminate on already-corrupt cycles and still permit detaching", { timeout: 10000 }, async () => {
  const prefix = `taxonomy-${randomUUID()}`;
  const nodes = await Promise.all(["a", "b", "c"].map((name) => prisma.topic.create({ data: { name, slug: `${prefix}-${name}` } })));
  const [a, b, c] = nodes;
  try {
    await prisma.topic.update({ where: { id: a.id }, data: { parentId: b.id } });
    await prisma.topic.update({ where: { id: b.id }, data: { parentId: a.id } });
    await assert.rejects(updateTopicSafely(c.id, { parentId: a.id }), (e: unknown) => e instanceof TaxonomyConflict && e.status === 400);
    await updateTopicSafely(a.id, { parentId: null });
    await updateTopicSafely(c.id, { parentId: b.id, name: " Valid move " });
    const updated = await updateTopicSafely(c.id, { description: "metadata only" });
    assert.equal(updated.parentId, b.id, "omitted parent must never overwrite a concurrent move");
    assert.equal(updated.name, "Valid move");
    await assert.rejects(updateTopicSafely(a.id, { parentId: c.id }), TaxonomyConflict);
    await assert.rejects(updateTopicSafely(a.id, { parentId: a.id }), TaxonomyConflict);
    await assert.rejects(updateTopicSafely(a.id, { parentId: "missing-topic" }), TaxonomyConflict);
    await assert.rejects(updateTopicSafely("missing-topic", {}), (e: unknown) => e instanceof TaxonomyConflict && e.status === 404);
  } finally {
    await prisma.topic.updateMany({ where: { id: { in: nodes.map((r) => r.id) } }, data: { parentId: null } });
    await prisma.topic.deleteMany({ where: { id: { in: nodes.map((r) => r.id) } } });
  }
});

test("tag deletion cannot cascade a link committed after its zero-use check", async () => {
  const prefix = `taxonomy-${randomUUID()}`;
  const topic = await prisma.topic.create({ data: { name: prefix, slug: prefix } });
  const article = await prisma.article.create({ data: { title: prefix, slug: prefix, content: "fixture", topicId: topic.id } });
  const tag = await prisma.tag.create({ data: { name: prefix, slug: prefix } });
  try {
    assert.equal(await prisma.articleTag.count({ where: { tagId: tag.id } }), 0);
    // The article writer commits while a deleting caller is between count and
    // DELETE. The database invariant must protect every writer, not just REST.
    await prisma.articleTag.create({ data: { articleId: article.id, tagId: tag.id } });
    await assert.rejects(prisma.tag.delete({ where: { id: tag.id } }), (e: unknown) => (e as { code?: string }).code === "P2003");
    assert.equal(await prisma.articleTag.count({ where: { tagId: tag.id } }), 1);
    await prisma.articleTag.deleteMany({ where: { tagId: tag.id } });
    await prisma.tag.delete({ where: { id: tag.id } });
    await assert.rejects(prisma.articleTag.create({ data: { articleId: article.id, tagId: tag.id } }), (e: unknown) => (e as { code?: string }).code === "P2003");
  } finally {
    await prisma.articleTag.deleteMany({ where: { articleId: article.id } });
    await prisma.tag.deleteMany({ where: { id: tag.id } });
    await prisma.article.delete({ where: { id: article.id } });
    await prisma.topic.delete({ where: { id: topic.id } });
  }
});
