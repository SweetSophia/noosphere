import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import test, { after, mock } from "node:test";
import type { PrismaClient } from "@prisma/client";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable must be set for tests");
}

const runId = crypto.randomUUID();
const topicSlug = `test-issue340-${runId}`;
const email = `test-issue340-${runId}@example.invalid`;
let editorId = "";
const sessionMock = mock.method(
  createRequire(import.meta.url)("next-auth/next"),
  "getServerSession",
  async () => ({ user: { id: editorId, role: "EDITOR", name: "Test editor" } }),
);
after(() => sessionMock.mock.restore());

async function setup(prisma: PrismaClient) {
  const editor = await prisma.user.create({
    data: { email, passwordHash: "test-only", role: "EDITOR" },
  });
  editorId = editor.id;
  return prisma.topic.create({ data: { name: `Issue 340 ${runId}`, slug: topicSlug } });
}

async function cleanup(prisma: PrismaClient) {
  await prisma.article.deleteMany({ where: { topic: { slug: topicSlug } } });
  await prisma.topic.deleteMany({ where: { slug: topicSlug } });
  await prisma.user.deleteMany({ where: { email } });
}

test("wiki create reports an injected-only title without writing an article", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { createArticleWithFeedback } = await import("@/app/wiki/[topicSlug]/new/actions");
  await cleanup(prisma);
  const topic = await setup(prisma);
  try {
    await assert.rejects(createArticleWithFeedback(topic.slug, new FormData()), /Title is required/);
    const form = new FormData();
    form.set("title", "< noosphere-context >private recall</ noosphere-context >");
    form.set("content", "Durable wiki content.");
    assert.equal(await createArticleWithFeedback(topic.slug, form), "Article title cannot consist only of injected context.");
    assert.equal(await prisma.article.count({ where: { topicId: topic.id } }), 0);
    assert.equal(await prisma.articleRevision.count({ where: { article: { topicId: topic.id } } }), 0);
  } finally {
    await cleanup(prisma);
  }
});

test("wiki edit reports an injected-only title and keeps the article unchanged", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { saveArticleWithFeedback } = await import("@/app/wiki/[topicSlug]/[articleSlug]/edit/actions");
  await cleanup(prisma);
  const topic = await setup(prisma);
  const article = await prisma.article.create({
    data: { title: `Issue 340 original ${runId}`, slug: "issue-340-original", content: "Original durable content.", topicId: topic.id },
  });
  try {
    const form = new FormData();
    form.set("title", "<recall>private recall</recall>");
    form.set("content", "Updated durable content.");
    form.set("status", "published");
    assert.equal(await saveArticleWithFeedback(topic.slug, article.slug, form), "Article title cannot consist only of injected context.");
    const after = await prisma.article.findUniqueOrThrow({ where: { id: article.id }, include: { revisions: true } });
    assert.equal(after.title, article.title);
    assert.equal(after.content, article.content);
    assert.equal(after.revisions.length, 0);
  } finally {
    await cleanup(prisma);
  }
});
