import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import JSZip from "jszip";
import type { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable must be set for tests");
}

const TEST_RUN_ID = crypto.randomUUID();
const TEST_PREFIX = `test-issue211-${TEST_RUN_ID}`;
const TEST_TITLE_PREFIX = `Issue 211 ${TEST_RUN_ID}`;
const TEST_TOPIC_SLUG = `${TEST_PREFIX}-topic`;
const TEST_KEY_NAME = `${TEST_PREFIX}-key`;
const TEST_CLIENT_IP = `10.211.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

function buildJsonRequest(
  path: string,
  rawKey: string,
  body: unknown,
): NextRequest {
  const request = new Request(`http://localhost${path}`, {
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

async function buildZip(
  articles: Array<{ filename: string; content: string }>,
): Promise<ArrayBuffer> {
  const zip = new JSZip();
  for (const article of articles) {
    zip.file(article.filename, article.content);
  }
  return zip.generateAsync({ type: "arraybuffer" });
}

function buildImportRequest(
  zipBuffer: ArrayBuffer,
  rawKey: string,
): NextRequest {
  const formData = new FormData();
  formData.set(
    "file",
    new Blob([zipBuffer], { type: "application/zip" }),
    "issue-211.zip",
  );

  const request = new Request("http://localhost/api/import", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${rawKey}`,
      "x-real-ip": TEST_CLIENT_IP,
    },
    body: formData,
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
    create: { name: `Test ${TEST_TITLE_PREFIX}`, slug: TEST_TOPIC_SLUG },
    update: {},
    select: { id: true },
  });
}

async function cleanupFixtures(prisma: PrismaClient): Promise<void> {
  await prisma.activityLog.deleteMany({
    where: {
      OR: [
        { authorName: { startsWith: TEST_KEY_NAME } },
        { title: { contains: TEST_TITLE_PREFIX } },
      ],
    },
  });
  await prisma.article.deleteMany({
    where: { topic: { slug: TEST_TOPIC_SLUG } },
  });
  await prisma.topic.deleteMany({ where: { slug: TEST_TOPIC_SLUG } });
  await prisma.apiKey.deleteMany({
    where: { name: { startsWith: TEST_KEY_NAME } },
  });
}

test("POST /api/answer strips injected blocks from content and excerpt", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { POST } = await import("@/app/api/answer/route");
  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;

  await cleanupFixtures(prisma);
  const topic = await setupTopic(prisma);
  await createWriteKey(prisma, rawKey);

  try {
    const response = await POST(buildJsonRequest("/api/answer", rawKey, {
      title: `${TEST_TITLE_PREFIX} Answer`,
      topicId: topic.id,
      content: [
        "Visible answer before.",
        "<recall>hidden recall sk-abcdefghijklmnopqrstuvwxyz</recall>",
        "Visible answer middle.",
        "<hindsight_memories>hidden hindsight</hindsight_memories>",
        "<noosphere_auto_recall>hidden auto</noosphere_auto_recall>",
        "Visible answer after.",
      ].join("\n"),
      excerpt: "Visible answer summary. <recall>hidden excerpt</recall>",
    }));
    const body = (await response.json()) as {
      article?: { id: string };
      error?: string;
    };

    assert.equal(response.status, 201, body.error);
    assert.ok(body.article?.id, "response should include created article id");

    const article = await prisma.article.findUnique({
      where: { id: body.article.id },
      include: { revisions: true },
    });
    assert.ok(article, "created answer article must exist");
    assert.match(article.content, /Visible answer before/);
    assert.match(article.content, /Visible answer middle/);
    assert.match(article.content, /Visible answer after/);
    assert.doesNotMatch(article.content, /<recall|<hindsight_memories|<noosphere_auto_recall/);
    assert.doesNotMatch(article.content, /hidden recall|hidden hindsight|hidden auto|sk-abcdefghijklmnopqrstuvwxyz/);
    assert.match(article.excerpt ?? "", /Visible answer summary/);
    assert.doesNotMatch(article.excerpt ?? "", /hidden excerpt|<recall/);
    assert.equal(article.revisions[0].content, article.content);

    const log = await prisma.activityLog.findFirst({
      where: {
        type: "article_content_stripped",
        title: { contains: `${TEST_TITLE_PREFIX} Answer` },
      },
    });
    assert.ok(log, "answer strip activity log should exist");
    assert.match(JSON.stringify(log.details), /POST \/api\/answer/);
    assert.match(JSON.stringify(log.details), /strippedBlockCount/);
    assert.match(JSON.stringify(log.details), /recall/);
  } finally {
    await cleanupFixtures(prisma);
  }
});

test("POST /api/answer rejects visible secrets after stripping injected blocks", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { POST } = await import("@/app/api/answer/route");
  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;

  await cleanupFixtures(prisma);
  const topic = await setupTopic(prisma);
  await createWriteKey(prisma, rawKey);

  try {
    const response = await POST(buildJsonRequest("/api/answer", rawKey, {
      title: `${TEST_TITLE_PREFIX} Answer Secret`,
      topicId: topic.id,
      content: "Visible answer content with api_key=abcdefghijklmnop",
    }));
    const body = (await response.json()) as { error?: string };

    assert.equal(response.status, 400);
    assert.match(body.error ?? "", /secret/);

    const article = await prisma.article.findFirst({
      where: { topicId: topic.id, title: `${TEST_TITLE_PREFIX} Answer Secret` },
    });
    assert.equal(article, null, "secret-bearing answer must not create an article");
  } finally {
    await cleanupFixtures(prisma);
  }
});

test("POST /api/answer rejects injected-only excerpts", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { POST } = await import("@/app/api/answer/route");
  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;

  await cleanupFixtures(prisma);
  const topic = await setupTopic(prisma);
  await createWriteKey(prisma, rawKey);

  try {
    const response = await POST(buildJsonRequest("/api/answer", rawKey, {
      title: `${TEST_TITLE_PREFIX} Answer Empty Excerpt`,
      topicId: topic.id,
      content: "Visible answer content.",
      excerpt: "<recall>hidden only</recall>",
    }));
    const body = (await response.json()) as { error?: string };

    assert.equal(response.status, 400);
    assert.equal(
      body.error,
      "Excerpt must include durable text outside injected memory blocks",
    );

    const article = await prisma.article.findFirst({
      where: { topicId: topic.id, title: `${TEST_TITLE_PREFIX} Answer Empty Excerpt` },
    });
    assert.equal(article, null, "injected-only excerpt must not create an article");
  } finally {
    await cleanupFixtures(prisma);
  }
});

test("POST /api/ingest strips malformed injected tails before batch persistence", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { POST } = await import("@/app/api/ingest/route");
  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;

  await cleanupFixtures(prisma);
  const topic = await setupTopic(prisma);
  await createWriteKey(prisma, rawKey);

  try {
    const response = await POST(buildJsonRequest("/api/ingest", rawKey, {
      source: { type: "text", title: `${TEST_TITLE_PREFIX} Ingest Source` },
      articles: [
        {
          title: `${TEST_TITLE_PREFIX} Ingest`,
          slug: "issue-211-ingest",
          topicId: topic.id,
          content: [
            "Visible ingest content.",
            "<recall>hidden malformed tail",
            "This tail must not persist.",
          ].join("\n"),
          excerpt: "Visible ingest summary. <hindsight_memories>hidden excerpt</hindsight_memories>",
        },
      ],
    }));
    const body = (await response.json()) as { error?: string; created?: number };

    assert.equal(response.status, 201, body.error);
    assert.equal(body.created, 1);

    const article = await prisma.article.findFirst({
      where: { topicId: topic.id, slug: "issue-211-ingest" },
      include: { revisions: true },
    });
    assert.ok(article, "ingested article should exist");
    assert.match(article.content, /Visible ingest content/);
    assert.doesNotMatch(article.content, /hidden malformed tail|This tail must not persist|<recall/);
    assert.match(article.excerpt ?? "", /Visible ingest summary/);
    assert.doesNotMatch(article.excerpt ?? "", /hidden excerpt|<hindsight_memories/);
    assert.equal(article.revisions[0].content, article.content);

    const log = await prisma.activityLog.findFirst({
      where: {
        type: "article_content_stripped",
        title: { contains: `${TEST_TITLE_PREFIX} Ingest Source` },
      },
    });
    assert.ok(log, "ingest strip activity log should exist");
    assert.match(JSON.stringify(log.details), /POST \/api\/ingest/);
    assert.match(JSON.stringify(log.details), /recall/);
  } finally {
    await cleanupFixtures(prisma);
  }
});

test("POST /api/ingest rejects the whole batch when one article is injected-only", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { POST } = await import("@/app/api/ingest/route");
  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;

  await cleanupFixtures(prisma);
  const topic = await setupTopic(prisma);
  await createWriteKey(prisma, rawKey);

  try {
    const response = await POST(buildJsonRequest("/api/ingest", rawKey, {
      source: { type: "text", title: `${TEST_TITLE_PREFIX} Ingest Reject Source` },
      articles: [
        {
          title: `${TEST_TITLE_PREFIX} Ingest Clean`,
          slug: "issue-211-ingest-clean",
          topicId: topic.id,
          content: "Visible clean content.",
        },
        {
          title: `${TEST_TITLE_PREFIX} Ingest Injected Only`,
          slug: "issue-211-ingest-injected-only",
          topicId: topic.id,
          content: "<recall>hidden only</recall>",
        },
      ],
    }));
    const body = (await response.json()) as { error?: string };

    assert.equal(response.status, 400);
    assert.match(body.error ?? "", /Article \[1\].*durable text/);

    const articles = await prisma.article.findMany({
      where: { topicId: topic.id },
    });
    assert.equal(articles.length, 0, "rejected ingest batch must not persist earlier clean articles");
  } finally {
    await cleanupFixtures(prisma);
  }
});

test("POST /api/import strips valid files and reports injected-only or secret files as errors", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { POST } = await import("@/app/api/import/route");
  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;

  await cleanupFixtures(prisma);
  await setupTopic(prisma);
  await createWriteKey(prisma, rawKey);

  try {
    const zipBuffer = await buildZip([
      {
        filename: "good.md",
        content: `---
title: ${TEST_TITLE_PREFIX} Import Good
topic: ${TEST_TOPIC_SLUG}
slug: issue-211-import-good
excerpt: "Visible import summary. <recall>hidden excerpt</recall>"
---
Visible import content.
<recall>hidden malformed tail
This tail must not persist.`,
      },
      {
        filename: "injected-only.md",
        content: `---
title: ${TEST_TITLE_PREFIX} Import Empty
topic: ${TEST_TOPIC_SLUG}
slug: issue-211-import-empty
---
<recall>hidden only</recall>`,
      },
      {
        filename: "secret.md",
        content: `---
title: ${TEST_TITLE_PREFIX} Import Secret
topic: ${TEST_TOPIC_SLUG}
slug: issue-211-import-secret
---
Visible import content with api_key=abcdefghijklmnop`,
      },
    ]);

    const response = await POST(buildImportRequest(zipBuffer, rawKey));
    const body = (await response.json()) as {
      summary?: { imported: number; errors: number };
      articles?: Array<{ filename: string; error?: string }>;
      error?: string;
    };

    assert.equal(response.status, 200, body.error);
    assert.equal(body.summary?.imported, 1);
    assert.equal(body.summary?.errors, 2);
    assert.match(
      body.articles?.find((article) => article.filename === "injected-only.md")?.error ?? "",
      /durable text/,
    );
    assert.match(
      body.articles?.find((article) => article.filename === "secret.md")?.error ?? "",
      /secret/,
    );

    const article = await prisma.article.findFirst({
      where: { slug: "issue-211-import-good" },
      include: { revisions: true },
    });
    assert.ok(article, "good import should create an article");
    assert.match(article.content, /Visible import content/);
    assert.doesNotMatch(article.content, /hidden malformed tail|This tail must not persist|<recall/);
    assert.match(article.excerpt ?? "", /Visible import summary/);
    assert.doesNotMatch(article.excerpt ?? "", /hidden excerpt|<recall/);
    assert.equal(article.revisions[0].content, article.content);

    const log = await prisma.activityLog.findFirst({
      where: {
        type: "article_content_stripped",
        title: { contains: `${TEST_TITLE_PREFIX} Import Good` },
      },
    });
    assert.ok(log, "import strip activity log should exist");
    assert.match(JSON.stringify(log.details), /good.md/);
    assert.match(JSON.stringify(log.details), /recall/);
  } finally {
    await cleanupFixtures(prisma);
  }
});
