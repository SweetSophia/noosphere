import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import JSZip from "jszip";
import type { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";

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

async function upsertImportApiKey(
  prisma: PrismaClient,
  rawKey: string,
  allowedScopes: string[],
  permissions: "WRITE" | "ADMIN" = "WRITE",
): Promise<void> {
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  const keyPrefix = rawKey.slice(0, 8);
  const existingKey = await prisma.apiKey.findFirst({
    where: { name: TEST_KEY_NAME },
  });
  if (existingKey) {
    await prisma.apiKey.update({
      where: { id: existingKey.id },
      data: { keyHash, keyPrefix, permissions, allowedScopes },
    });
  } else {
    await prisma.apiKey.create({
      data: {
        name: TEST_KEY_NAME,
        keyHash,
        keyPrefix,
        permissions,
        allowedScopes,
      },
    });
  }
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

test("POST /api/import preserves existing restrictedTags when scoped overwrite omits them", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { POST } = await import("@/app/api/import/route");

  await prisma.restrictedScope.upsert({
    where: { tag: TEST_SCOPE_OWNED },
    create: { tag: TEST_SCOPE_OWNED, description: "Test owned scope" },
    update: {},
  });
  const topic = await prisma.topic.upsert({
    where: { slug: TEST_TOPIC_SLUG },
    create: { name: "Test Import Validation", slug: TEST_TOPIC_SLUG },
    update: {},
  });

  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;
  await upsertImportApiKey(prisma, rawKey, [TEST_SCOPE_OWNED]);

  try {
    await prisma.article.deleteMany({
      where: { slug: "classified-article", topicId: topic.id },
    });
    await prisma.article.create({
      data: {
        title: "Classified Article",
        slug: "classified-article",
        topicId: topic.id,
        content: "Old restricted content",
        restrictedTags: [TEST_SCOPE_OWNED],
      },
    });

    const zipBuffer = await buildZip([
      {
        filename: "classified-article.md",
        content: `---
title: Classified Article
topic: ${TEST_TOPIC_SLUG}
slug: classified-article
---

# Classified Article

Updated content without restrictedTags frontmatter.`,
      },
    ]);

    const request = buildImportRequest(zipBuffer, rawKey, "true");
    const response = await POST(request);
    const body = (await response.json()) as {
      summary: { imported: number; errors: number };
    };

    assert.equal(body.summary.imported, 1, "article should be overwritten");
    assert.equal(body.summary.errors, 0, "omitted restrictedTags should preserve, not error");

    const updated = await prisma.article.findFirstOrThrow({
      where: { slug: "classified-article", topicId: topic.id },
    });
    assert.deepEqual(
      updated.restrictedTags,
      [TEST_SCOPE_OWNED],
      "omitted restrictedTags must preserve the existing classification",
    );
    assert.ok(updated.content.includes("Updated content"));
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

test("POST /api/import rejects scoped overwrite that declassifies an existing restricted article", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { POST } = await import("@/app/api/import/route");

  await prisma.restrictedScope.upsert({
    where: { tag: TEST_SCOPE_OWNED },
    create: { tag: TEST_SCOPE_OWNED, description: "Test owned scope" },
    update: {},
  });
  const topic = await prisma.topic.upsert({
    where: { slug: TEST_TOPIC_SLUG },
    create: { name: "Test Import Validation", slug: TEST_TOPIC_SLUG },
    update: {},
  });

  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;
  await upsertImportApiKey(prisma, rawKey, [TEST_SCOPE_OWNED]);

  try {
    await prisma.article.deleteMany({
      where: { slug: "declassify-attempt", topicId: topic.id },
    });
    await prisma.article.create({
      data: {
        title: "Declassify Attempt",
        slug: "declassify-attempt",
        topicId: topic.id,
        content: "Original restricted content",
        restrictedTags: [TEST_SCOPE_OWNED],
      },
    });

    const zipBuffer = await buildZip([
      {
        filename: "declassify-attempt.md",
        content: `---
title: Declassify Attempt
topic: ${TEST_TOPIC_SLUG}
slug: declassify-attempt
restrictedTags: []
---

# Declassify Attempt

This update tries to make restricted content public.`,
      },
    ]);

    const request = buildImportRequest(zipBuffer, rawKey, "true");
    const response = await POST(request);
    const body = (await response.json()) as {
      summary: { imported: number; errors: number };
      articles: Array<{ filename: string; error?: string }>;
    };

    assert.equal(body.summary.imported, 0, "declassification must not import");
    assert.equal(body.summary.errors, 1, "declassification should be an article error");
    assert.match(
      body.articles[0]?.error ?? "",
      /requires ADMIN access/,
      "error should name the required privilege",
    );

    const unchanged = await prisma.article.findFirstOrThrow({
      where: { slug: "declassify-attempt", topicId: topic.id },
    });
    assert.deepEqual(unchanged.restrictedTags, [TEST_SCOPE_OWNED]);
    assert.equal(unchanged.content, "Original restricted content");
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

test("POST /api/import allows ADMIN overwrite to declassify an existing restricted article", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { POST } = await import("@/app/api/import/route");

  await prisma.restrictedScope.upsert({
    where: { tag: TEST_SCOPE_OWNED },
    create: { tag: TEST_SCOPE_OWNED, description: "Test owned scope" },
    update: {},
  });
  const topic = await prisma.topic.upsert({
    where: { slug: TEST_TOPIC_SLUG },
    create: { name: "Test Import Validation", slug: TEST_TOPIC_SLUG },
    update: {},
  });

  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;
  await upsertImportApiKey(prisma, rawKey, ["*"], "ADMIN");

  try {
    await prisma.article.deleteMany({
      where: { slug: "admin-declassify", topicId: topic.id },
    });
    await prisma.article.create({
      data: {
        title: "Admin Declassify",
        slug: "admin-declassify",
        topicId: topic.id,
        content: "Original restricted content",
        restrictedTags: [TEST_SCOPE_OWNED],
      },
    });

    const zipBuffer = await buildZip([
      {
        filename: "admin-declassify.md",
        content: `---
title: Admin Declassify
topic: ${TEST_TOPIC_SLUG}
slug: admin-declassify
restrictedTags: []
---

# Admin Declassify

ADMIN explicitly makes this article public.`,
      },
    ]);

    const request = buildImportRequest(zipBuffer, rawKey, "true");
    const response = await POST(request);
    const body = (await response.json()) as {
      summary: { imported: number; errors: number };
    };

    assert.equal(body.summary.imported, 1, "ADMIN declassification should import");
    assert.equal(body.summary.errors, 0, "ADMIN declassification should not error");

    const updated = await prisma.article.findFirstOrThrow({
      where: { slug: "admin-declassify", topicId: topic.id },
    });
    assert.deepEqual(updated.restrictedTags, []);

    const logEntry = await prisma.activityLog.findFirst({
      where: {
        type: "update",
        title: "Updated restrictedTags via import: Admin Declassify",
      },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(logEntry, "classification changes should be audit logged");
    const details = (logEntry?.details ?? {}) as Record<string, unknown>;
    assert.equal(
      details.declassified,
      true,
      "declassification must set declassified: true (C3)",
    );
    assert.equal(
      details.classified,
      false,
      "declassification must not also set classified: true (C3)",
    );
    assert.equal(
      details.reclassified,
      false,
      "declassification must not also set reclassified: true (C3)",
    );
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
    await prisma.activityLog.deleteMany({
      where: { title: "Updated restrictedTags via import: Admin Declassify" },
    });
  }
});

test("POST /api/import rejects scoped WRITE overwrite that classifies an existing unrestricted article (C2)", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { POST } = await import("@/app/api/import/route");

  await prisma.restrictedScope.upsert({
    where: { tag: TEST_SCOPE_OWNED },
    create: { tag: TEST_SCOPE_OWNED, description: "Test owned scope" },
    update: {},
  });
  const topic = await prisma.topic.upsert({
    where: { slug: TEST_TOPIC_SLUG },
    create: { name: "Test Import Validation", slug: TEST_TOPIC_SLUG },
    update: {},
  });

  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;
  await upsertImportApiKey(prisma, rawKey, [TEST_SCOPE_OWNED]);

  try {
    await prisma.article.deleteMany({
      where: { slug: "classify-attempt", topicId: topic.id },
    });
    await prisma.article.create({
      data: {
        title: "Classify Attempt",
        slug: "classify-attempt",
        topicId: topic.id,
        content: "Originally public content",
        restrictedTags: [],
      },
    });

    const zipBuffer = await buildZip([
      {
        filename: "classify-attempt.md",
        content: `---
title: Classify Attempt
topic: ${TEST_TOPIC_SLUG}
slug: classify-attempt
restrictedTags: [${TEST_SCOPE_OWNED}]
---

# Classify Attempt

This update tries to take a public article and classify it.`,
      },
    ]);

    const request = buildImportRequest(zipBuffer, rawKey, "true");
    const response = await POST(request);
    const body = (await response.json()) as {
      summary: { imported: number; errors: number };
      articles: Array<{ filename: string; error?: string }>;
    };

    assert.equal(
      body.summary.imported,
      0,
      "scoped classification must not import (C2)",
    );
    assert.equal(
      body.summary.errors,
      1,
      "scoped classification should be an article error",
    );
    assert.match(
      body.articles[0]?.error ?? "",
      /requires ADMIN access/,
      "error should name the required privilege",
    );

    const unchanged = await prisma.article.findFirstOrThrow({
      where: { slug: "classify-attempt", topicId: topic.id },
    });
    assert.deepEqual(
      unchanged.restrictedTags,
      [],
      "public classification must be rejected for scoped WRITE",
    );
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

test("POST /api/import allows ADMIN overwrite to classify an existing unrestricted article (C2)", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { POST } = await import("@/app/api/import/route");

  await prisma.restrictedScope.upsert({
    where: { tag: TEST_SCOPE_OWNED },
    create: { tag: TEST_SCOPE_OWNED, description: "Test owned scope" },
    update: {},
  });
  const topic = await prisma.topic.upsert({
    where: { slug: TEST_TOPIC_SLUG },
    create: { name: "Test Import Validation", slug: TEST_TOPIC_SLUG },
    update: {},
  });

  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;
  await upsertImportApiKey(prisma, rawKey, ["*"], "ADMIN");

  try {
    await prisma.article.deleteMany({
      where: { slug: "admin-classify", topicId: topic.id },
    });
    await prisma.article.create({
      data: {
        title: "Admin Classify",
        slug: "admin-classify",
        topicId: topic.id,
        content: "Originally public content",
        restrictedTags: [],
      },
    });

    const zipBuffer = await buildZip([
      {
        filename: "admin-classify.md",
        content: `---
title: Admin Classify
topic: ${TEST_TOPIC_SLUG}
slug: admin-classify
restrictedTags: [${TEST_SCOPE_OWNED}]
---

# Admin Classify

ADMIN explicitly classifies an existing public article.`,
      },
    ]);

    const request = buildImportRequest(zipBuffer, rawKey, "true");
    const response = await POST(request);
    const body = (await response.json()) as {
      summary: { imported: number; errors: number };
    };

    assert.equal(body.summary.imported, 1, "ADMIN classification should import");
    assert.equal(body.summary.errors, 0, "ADMIN classification should not error");

    const updated = await prisma.article.findFirstOrThrow({
      where: { slug: "admin-classify", topicId: topic.id },
    });
    assert.deepEqual(updated.restrictedTags, [TEST_SCOPE_OWNED]);

    const logEntry = await prisma.activityLog.findFirst({
      where: {
        type: "update",
        title: "Updated restrictedTags via import: Admin Classify",
      },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(logEntry, "first-time classification should be audit logged");
    const details = (logEntry?.details ?? {}) as Record<string, unknown>;
    assert.equal(
      details.classified,
      true,
      "first-time classification must set classified: true (C3)",
    );
    assert.equal(
      details.declassified,
      false,
      "first-time classification must not also set declassified: true (C3)",
    );
    assert.equal(
      details.reclassified,
      false,
      "first-time classification must not also set reclassified: true (C3)",
    );
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
    await prisma.activityLog.deleteMany({
      where: { title: "Updated restrictedTags via import: Admin Classify" },
    });
  }
});

test("POST /api/import rejects scoped WRITE overwrite that reclassifies a restricted article (C2 + C4)", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { POST } = await import("@/app/api/import/route");

  await prisma.restrictedScope.upsert({
    where: { tag: TEST_SCOPE_OWNED },
    create: { tag: TEST_SCOPE_OWNED, description: "Test owned scope" },
    update: {},
  });
  await prisma.restrictedScope.upsert({
    where: { tag: `${TEST_PREFIX}other` },
    create: {
      tag: `${TEST_PREFIX}other`,
      description: "Test other scope",
    },
    update: {},
  });
  const topic = await prisma.topic.upsert({
    where: { slug: TEST_TOPIC_SLUG },
    create: { name: "Test Import Validation", slug: TEST_TOPIC_SLUG },
    update: {},
  });

  // Give the caller both scopes so the can-assign check passes; the
  // reclassification must still be blocked by the C2 ADMIN gate because
  // the existing restricted set is being changed.
  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;
  await upsertImportApiKey(prisma, rawKey, [
    TEST_SCOPE_OWNED,
    `${TEST_PREFIX}other`,
  ]);

  try {
    await prisma.article.deleteMany({
      where: { slug: "reclassify-attempt", topicId: topic.id },
    });
    await prisma.article.create({
      data: {
        title: "Reclassify Attempt",
        slug: "reclassify-attempt",
        topicId: topic.id,
        content: "Original restricted content",
        restrictedTags: [TEST_SCOPE_OWNED],
      },
    });

    const zipBuffer = await buildZip([
      {
        filename: "reclassify-attempt.md",
        content: `---
title: Reclassify Attempt
topic: ${TEST_TOPIC_SLUG}
slug: reclassify-attempt
restrictedTags: [${TEST_SCOPE_OWNED}, ${TEST_PREFIX}other]
---

# Reclassify Attempt

Tries to expand the access boundary on an already restricted article.`,
      },
    ]);

    const request = buildImportRequest(zipBuffer, rawKey, "true");
    const response = await POST(request);
    const body = (await response.json()) as {
      summary: { imported: number; errors: number };
      articles: Array<{ filename: string; error?: string }>;
    };

    assert.equal(body.summary.imported, 0, "reclassification must not import");
    assert.equal(body.summary.errors, 1, "reclassification should be an article error");
    assert.match(
      body.articles[0]?.error ?? "",
      /requires ADMIN access/,
      "reclassification by a scoped WRITE key must hit the ADMIN gate (C2)",
    );

    const unchanged = await prisma.article.findFirstOrThrow({
      where: { slug: "reclassify-attempt", topicId: topic.id },
    });
    assert.deepEqual(unchanged.restrictedTags, [TEST_SCOPE_OWNED]);
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
      where: {
        tag: { in: [TEST_SCOPE_OWNED, `${TEST_PREFIX}other`] },
      },
    });
  }
});

test("POST /api/import allows scoped WRITE overwrite to leave restrictedTags unchanged (C4)", async () => {
  // Pins the C4 fix: `[a, a]` from the import file dedupes to `{a}` and is
  // therefore a no-op against an existing `[a]`. The pre-fix implementation
  // would have flagged this as a change and blocked the call with
  // "requires ADMIN access".
  const { prisma } = await import("@/lib/prisma");
  const { POST } = await import("@/app/api/import/route");

  await prisma.restrictedScope.upsert({
    where: { tag: TEST_SCOPE_OWNED },
    create: { tag: TEST_SCOPE_OWNED, description: "Test owned scope" },
    update: {},
  });
  const topic = await prisma.topic.upsert({
    where: { slug: TEST_TOPIC_SLUG },
    create: { name: "Test Import Validation", slug: TEST_TOPIC_SLUG },
    update: {},
  });

  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;
  await upsertImportApiKey(prisma, rawKey, [TEST_SCOPE_OWNED]);

  try {
    await prisma.article.deleteMany({
      where: { slug: "duplicate-tags", topicId: topic.id },
    });
    await prisma.article.create({
      data: {
        title: "Duplicate Tags",
        slug: "duplicate-tags",
        topicId: topic.id,
        content: "Original content",
        restrictedTags: [TEST_SCOPE_OWNED],
      },
    });

    const zipBuffer = await buildZip([
      {
        filename: "duplicate-tags.md",
        content: `---
title: Duplicate Tags
topic: ${TEST_TOPIC_SLUG}
slug: duplicate-tags
restrictedTags: [${TEST_SCOPE_OWNED}, ${TEST_SCOPE_OWNED}]
---

# Duplicate Tags

restrictedTags carries an accidental duplicate; after dedup it equals
the existing set, so the change check should treat it as a no-op.`,
      },
    ]);

    const request = buildImportRequest(zipBuffer, rawKey, "true");
    const response = await POST(request);
    const body = (await response.json()) as {
      summary: { imported: number; errors: number };
    };

    assert.equal(
      body.summary.imported,
      1,
      "duplicate-but-equivalent restrictedTags must be a no-op (C4)",
    );
    assert.equal(body.summary.errors, 0, "no error should be raised for a no-op");
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
