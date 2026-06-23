import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable must be set for tests");
}

const TEST_RUN_ID = crypto.randomUUID();
const TEST_PREFIX = `test-issue208-patch-${TEST_RUN_ID}`;
const TEST_TOPIC_SLUG = `${TEST_PREFIX}-topic`;
const TEST_KEY_NAME = `${TEST_PREFIX}-key`;
const TEST_CLIENT_IP = `10.209.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

function buildPatchRequest(
  articleId: string,
  body: unknown,
  rawKey: string,
): NextRequest {
  const request = new Request(`http://localhost/api/articles/${articleId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${rawKey}`,
      "Content-Type": "application/json",
      "x-real-ip": TEST_CLIENT_IP,
    },
    body: JSON.stringify(body),
  });
  return request as unknown as NextRequest;
}

async function createWriteKey(
  prisma: PrismaClient,
  rawKey: string,
): Promise<void> {
  await prisma.apiKey.create({
    data: {
      name: TEST_KEY_NAME,
      keyHash: crypto.createHash("sha256").update(rawKey).digest("hex"),
      keyPrefix: rawKey.slice(0, 8),
      permissions: "WRITE",
      allowedScopes: ["*"],
    },
  });
}

async function setupTopic(prisma: PrismaClient): Promise<{ id: string }> {
  return prisma.topic.create({
    data: { name: "Test Issue 208 Patch", slug: TEST_TOPIC_SLUG },
    select: { id: true },
  });
}

async function createArticle(
  prisma: PrismaClient,
  topicId: string,
  slug: string,
  content = "Original durable content.",
) {
  return prisma.article.create({
    data: {
      title: `Patch ${slug}`,
      slug,
      content,
      excerpt: "Original excerpt.",
      topicId,
      authorName: TEST_KEY_NAME,
    },
  });
}

async function cleanupFixtures(prisma: PrismaClient): Promise<void> {
  await prisma.article.deleteMany({
    where: { topic: { slug: TEST_TOPIC_SLUG } },
  });
  await prisma.topic.deleteMany({ where: { slug: TEST_TOPIC_SLUG } });
  await prisma.apiKey.deleteMany({ where: { name: TEST_KEY_NAME } });
}

test("PATCH /api/articles/[id] strips injected memory blocks before persistence", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { PATCH } = await import("@/app/api/articles/[id]/route");
  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;

  await cleanupFixtures(prisma);
  const topic = await setupTopic(prisma);
  await createWriteKey(prisma, rawKey);
  const article = await createArticle(prisma, topic.id, "patch-strip");

  try {
    const content = [
      "Visible preamble.",
      "<recall>hidden recall sk-abcdefghijklmnopqrstuvwxyz</recall>",
      "Visible middle.",
      "<hindsight_memories>hidden hindsight</hindsight_memories>",
      "<noosphere_auto_recall>hidden auto</noosphere_auto_recall>",
      "Visible ending.",
    ].join("\n");

    const response = await PATCH(
      buildPatchRequest(article.id, {
        content,
        excerpt: "Visible patch summary. <recall>hidden excerpt</recall>",
      }, rawKey),
      { params: Promise.resolve({ id: article.id }) },
    );
    const body = (await response.json()) as { error?: string };

    assert.equal(response.status, 200, body.error);

    const after = await prisma.article.findUnique({
      where: { id: article.id },
      include: { revisions: true },
    });
    assert.ok(after, "article must still exist");
    assert.match(after.content, /Visible preamble/);
    assert.match(after.content, /Visible middle/);
    assert.match(after.content, /Visible ending/);
    assert.doesNotMatch(after.content, /<recall|<hindsight_memories|<noosphere_auto_recall/);
    assert.doesNotMatch(after.content, /hidden recall|hidden hindsight|hidden auto|sk-abcdefghijklmnopqrstuvwxyz/);
    assert.match(after.excerpt ?? "", /Visible patch summary/);
    assert.doesNotMatch(after.excerpt ?? "", /<recall|hidden excerpt/);
    assert.equal(after.revisions.length, 1, "content PATCH should create one revision");
    assert.equal(
      after.revisions[0].content,
      after.content,
      "revision content must match stripped article content",
    );
  } finally {
    await cleanupFixtures(prisma);
  }
});

test("PATCH /api/articles/[id] rejects content made only of injected memory blocks", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { PATCH } = await import("@/app/api/articles/[id]/route");
  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;

  await cleanupFixtures(prisma);
  const topic = await setupTopic(prisma);
  await createWriteKey(prisma, rawKey);
  const article = await createArticle(prisma, topic.id, "patch-empty");

  try {
    const response = await PATCH(
      buildPatchRequest(article.id, {
        content: "<recall>hidden only</recall>",
      }, rawKey),
      { params: Promise.resolve({ id: article.id }) },
    );
    const body = (await response.json()) as { error?: string };

    assert.equal(response.status, 400);
    assert.equal(
      body.error,
      "Content must include durable text outside injected memory blocks",
    );

    const after = await prisma.article.findUnique({
      where: { id: article.id },
      include: { revisions: true },
    });
    assert.ok(after, "article must still exist");
    assert.equal(after.content, article.content);
    assert.equal(after.revisions.length, 0, "rejected content must not create a revision");
  } finally {
    await cleanupFixtures(prisma);
  }
});

test("PATCH /api/articles/[id] rejects visible secrets after stripping", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { PATCH } = await import("@/app/api/articles/[id]/route");
  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;

  await cleanupFixtures(prisma);
  const topic = await setupTopic(prisma);
  await createWriteKey(prisma, rawKey);
  const article = await createArticle(prisma, topic.id, "patch-secret");

  try {
    const response = await PATCH(
      buildPatchRequest(article.id, {
        content: "Visible content with api_key=abcdefghijklmnop",
      }, rawKey),
      { params: Promise.resolve({ id: article.id }) },
    );
    const body = (await response.json()) as { error?: string };

    assert.equal(response.status, 400);
    assert.match(body.error ?? "", /secret/);

    const after = await prisma.article.findUnique({
      where: { id: article.id },
      include: { revisions: true },
    });
    assert.ok(after, "article must still exist");
    assert.equal(after.content, article.content);
    assert.equal(after.revisions.length, 0, "secret rejection must not create a revision");
  } finally {
    await cleanupFixtures(prisma);
  }
});
