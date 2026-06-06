import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import JSZip from "jszip";
import type { NextRequest } from "next/server";

// Connect to dev DB before any module that reads it loads.
// This test requires the local dev stack: `docker compose up -d db redis`.
process.env.DATABASE_URL ??=
  "postgresql://noosphere:noosphere_secret@127.0.0.1:5433/noosphere";

const TEST_PREFIX = "test-issue136-";
const TEST_SCOPE_OWNED = `${TEST_PREFIX}owned`;
const TEST_SCOPE_FORBIDDEN = `${TEST_PREFIX}forbidden`;
const TEST_TOPIC_SLUG = `${TEST_PREFIX}topic`;
const TEST_KEY_NAME = `${TEST_PREFIX}key`;
const TEST_CLIENT_IP = `10.99.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

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
  overwrite: "true" | "false" = "false",
): NextRequest {
  const formData = new FormData();
  formData.set(
    "file",
    new Blob([zipBuffer], { type: "application/zip" }),
    "test.zip",
  );
  formData.set("overwrite", overwrite);

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

// ─── Issue #136: Import must validate caller can assign restrictedTags ─────

test("POST /api/import rejects articles with restrictedTags the caller cannot assign (issue #136)", async () => {
  // Imports happen inside the test so DATABASE_URL is set first.
  const { prisma } = await import("@/lib/prisma");
  const { POST } = await import("@/app/api/import/route");

  // Set up test data: restricted scopes, topic, and an API key that only has the "owned" scope.
  await prisma.restrictedScope.upsert({
    where: { tag: TEST_SCOPE_OWNED },
    create: { tag: TEST_SCOPE_OWNED, description: "Test owned scope" },
    update: {},
  });
  await prisma.restrictedScope.upsert({
    where: { tag: TEST_SCOPE_FORBIDDEN },
    create: { tag: TEST_SCOPE_FORBIDDEN, description: "Test forbidden scope" },
    update: {},
  });
  await prisma.topic.upsert({
    where: { slug: TEST_TOPIC_SLUG },
    create: { name: "Test Import Validation", slug: TEST_TOPIC_SLUG },
    update: {},
  });

  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  const keyPrefix = rawKey.slice(0, 8);
  const existingKey = await prisma.apiKey.findFirst({
    where: { name: TEST_KEY_NAME },
  });
  if (existingKey) {
    await prisma.apiKey.update({
      where: { id: existingKey.id },
      data: { keyHash, keyPrefix, allowedScopes: [TEST_SCOPE_OWNED] },
    });
  } else {
    await prisma.apiKey.create({
      data: {
        name: TEST_KEY_NAME,
        keyHash,
        keyPrefix,
        permissions: "WRITE",
        allowedScopes: [TEST_SCOPE_OWNED],
      },
    });
  }

  try {
    const zipBuffer = await buildZip([
      {
        filename: "evil-article.md",
        content: `---
title: Evil Article
topic: ${TEST_TOPIC_SLUG}
slug: evil-article
restrictedTags:
  - ${TEST_SCOPE_FORBIDDEN}
---

# Evil Article

This tries to assign a scope the caller does not have.`,
      },
    ]);

    const request = buildImportRequest(zipBuffer, rawKey);
    const response = await POST(request);
    const body = (await response.json()) as {
      success: boolean;
      summary: { imported: number; errors: number };
      articles: Array<{ filename: string; error?: string }>;
    };

    const evilArticle = body.articles.find(
      (a) => a.filename === "evil-article.md",
    );
    assert.ok(evilArticle, "evil article should appear in the response");
    assert.ok(
      evilArticle.error,
      `evil article should have an error, got: ${JSON.stringify(evilArticle)}`,
    );
    assert.ok(
      evilArticle.error.includes(TEST_SCOPE_FORBIDDEN),
      `error should mention the forbidden scope, got: ${evilArticle.error}`,
    );
    assert.equal(body.summary.imported, 0, "no articles should be imported");
    assert.equal(body.summary.errors, 1, "summary should show 1 error");

    // Confirm the article was not created in the DB
    const created = await prisma.article.findFirst({
      where: { slug: "evil-article", topic: { slug: TEST_TOPIC_SLUG } },
    });
    assert.equal(created, null, "evil article must not be persisted");
  } finally {
    // Clean up: reverse dependency order
    await prisma.article.deleteMany({
      where: { topic: { slug: TEST_TOPIC_SLUG } },
    });
    await prisma.topic.deleteMany({
      where: { slug: TEST_TOPIC_SLUG },
    });
    await prisma.apiKey.deleteMany({
      where: { name: TEST_KEY_NAME },
    });
    await prisma.restrictedScope.deleteMany({
      where: { tag: { in: [TEST_SCOPE_OWNED, TEST_SCOPE_FORBIDDEN] } },
    });
  }
});

test("POST /api/import accepts articles with restrictedTags the caller can assign", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { POST } = await import("@/app/api/import/route");

  // Reuse the same setup as the first test (idempotent upserts).
  await prisma.restrictedScope.upsert({
    where: { tag: TEST_SCOPE_OWNED },
    create: { tag: TEST_SCOPE_OWNED, description: "Test owned scope" },
    update: {},
  });
  await prisma.topic.upsert({
    where: { slug: TEST_TOPIC_SLUG },
    create: { name: "Test Import Validation", slug: TEST_TOPIC_SLUG },
    update: {},
  });

  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  const keyPrefix = rawKey.slice(0, 8);
  const existingKey = await prisma.apiKey.findFirst({
    where: { name: TEST_KEY_NAME },
  });
  if (existingKey) {
    await prisma.apiKey.update({
      where: { id: existingKey.id },
      data: { keyHash, keyPrefix, allowedScopes: [TEST_SCOPE_OWNED] },
    });
  } else {
    await prisma.apiKey.create({
      data: {
        name: TEST_KEY_NAME,
        keyHash,
        keyPrefix,
        permissions: "WRITE",
        allowedScopes: [TEST_SCOPE_OWNED],
      },
    });
  }

  try {
    const zipBuffer = await buildZip([
      {
        filename: "good-article.md",
        content: `---
title: Good Article
topic: ${TEST_TOPIC_SLUG}
slug: good-article
restrictedTags:
  - ${TEST_SCOPE_OWNED}
---

# Good Article

This assigns a scope the caller has.`,
      },
    ]);

    const request = buildImportRequest(zipBuffer, rawKey);
    const response = await POST(request);
    const body = (await response.json()) as {
      summary: { imported: number; errors: number };
      articles: Array<{ filename: string; error?: string }>;
    };

    assert.equal(body.summary.imported, 1, "good article should be imported");
    assert.equal(body.summary.errors, 0, "no errors expected");
  } finally {
    await prisma.article.deleteMany({
      where: { topic: { slug: TEST_TOPIC_SLUG } },
    });
    await prisma.topic.deleteMany({
      where: { slug: TEST_TOPIC_SLUG },
    });
    await prisma.apiKey.deleteMany({
      where: { name: TEST_KEY_NAME },
    });
    await prisma.restrictedScope.deleteMany({
      where: { tag: { in: [TEST_SCOPE_OWNED, TEST_SCOPE_FORBIDDEN] } },
    });
  }
});
