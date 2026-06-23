import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";

// Route-level test for issue #208. It exercises the real POST /api/articles
// handler so direct HTTP callers get the same injected-memory protection as
// agent adapters.
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable must be set for tests");
}

const TEST_RUN_ID = crypto.randomUUID();
const TEST_PREFIX = `test-issue208-${TEST_RUN_ID}`;
const TEST_TOPIC_SLUG = `${TEST_PREFIX}-topic`;
const TEST_KEY_NAME = `${TEST_PREFIX}-key`;
const TEST_CLIENT_IP = `10.208.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

function buildPostRequest(rawKey: string, body: unknown): NextRequest {
  const request = new Request("http://localhost/api/articles", {
    method: "POST",
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
      name: `${TEST_KEY_NAME}-${crypto.randomUUID()}`,
      keyHash: crypto.createHash("sha256").update(rawKey).digest("hex"),
      keyPrefix: rawKey.slice(0, 8),
      permissions: "WRITE",
      allowedScopes: ["*"],
    },
  });
}

async function setupTopic(prisma: PrismaClient): Promise<{ id: string }> {
  return prisma.topic.upsert({
    where: { slug: TEST_TOPIC_SLUG },
    create: { name: "Test Issue 208", slug: TEST_TOPIC_SLUG },
    update: {},
    select: { id: true },
  });
}

async function cleanupFixtures(prisma: PrismaClient): Promise<void> {
  await prisma.article.deleteMany({
    where: { topic: { slug: TEST_TOPIC_SLUG } },
  });
  await prisma.topic.deleteMany({ where: { slug: TEST_TOPIC_SLUG } });
  await prisma.apiKey.deleteMany({
    where: { name: { startsWith: TEST_KEY_NAME } },
  });
}

test("POST /api/articles strips injected memory blocks before persistence (issue #208)", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { POST } = await import("@/app/api/articles/route");
  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;

  await cleanupFixtures(prisma);
  const topic = await setupTopic(prisma);
  await createWriteKey(prisma, rawKey);

  try {
    const content = [
      "Visible before.",
      "<recall>hidden recall</recall>",
      "Visible middle.",
      "<hindsight_memories>hidden hindsight</hindsight_memories>",
      "<noosphere_auto_recall>hidden auto</noosphere_auto_recall>",
      "Visible after.",
    ].join("\n");

    const response = await POST(buildPostRequest(rawKey, {
      title: "Issue 208 Article",
      slug: "issue-208-article",
      content,
      excerpt: "Visible summary. <recall>hidden excerpt</recall>",
      topicId: topic.id,
    }));
    const body = (await response.json()) as { id?: string; error?: string };

    assert.equal(response.status, 201, body.error);
    assert.ok(body.id, "response should include created article id");

    const article = await prisma.article.findUnique({
      where: { id: body.id },
      include: { revisions: true },
    });
    assert.ok(article, "created article must exist");
    assert.match(article.content, /Visible before/);
    assert.match(article.content, /Visible middle/);
    assert.match(article.content, /Visible after/);
    assert.doesNotMatch(article.content, /<recall|<hindsight_memories|<noosphere_auto_recall/);
    assert.doesNotMatch(article.content, /hidden recall|hidden hindsight|hidden auto/);
    assert.match(article.excerpt ?? "", /Visible summary/);
    assert.doesNotMatch(article.excerpt ?? "", /<recall|hidden excerpt/);
    assert.equal(article.revisions.length, 1, "initial revision should be created");
    assert.equal(
      article.revisions[0].content,
      article.content,
      "initial revision must store the same stripped content",
    );
  } finally {
    await cleanupFixtures(prisma);
  }
});

test("POST /api/articles truncates malformed injected memory tails before persistence", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { POST } = await import("@/app/api/articles/route");
  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;

  await cleanupFixtures(prisma);
  const topic = await setupTopic(prisma);
  await createWriteKey(prisma, rawKey);

  try {
    const response = await POST(buildPostRequest(rawKey, {
      title: "Issue 208 Malformed",
      slug: "issue-208-malformed",
      content: [
        "Visible durable content.",
        "<recall>hidden tail",
        "This should not persist.",
      ].join("\n"),
      topicId: topic.id,
    }));
    const body = (await response.json()) as { id?: string; error?: string };

    assert.equal(response.status, 201, body.error);
    assert.ok(body.id, "response should include created article id");

    const article = await prisma.article.findUnique({ where: { id: body.id } });
    assert.ok(article, "created article must exist");
    assert.match(article.content, /Visible durable content/);
    assert.doesNotMatch(article.content, /hidden tail|This should not persist/);
  } finally {
    await cleanupFixtures(prisma);
  }
});

test("POST /api/articles rejects content made only of injected memory blocks", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { POST } = await import("@/app/api/articles/route");
  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;

  await cleanupFixtures(prisma);
  const topic = await setupTopic(prisma);
  await createWriteKey(prisma, rawKey);

  try {
    const response = await POST(buildPostRequest(rawKey, {
      title: "Issue 208 Empty",
      slug: "issue-208-empty",
      content: "<recall>hidden only</recall>",
      topicId: topic.id,
    }));
    const body = (await response.json()) as { error?: string };

    assert.equal(response.status, 400);
    assert.equal(
      body.error,
      "Content must include durable text outside injected memory blocks",
    );

    const article = await prisma.article.findFirst({
      where: { topicId: topic.id, slug: "issue-208-empty" },
    });
    assert.equal(article, null, "invalid content must not create an article");
  } finally {
    await cleanupFixtures(prisma);
  }
});
