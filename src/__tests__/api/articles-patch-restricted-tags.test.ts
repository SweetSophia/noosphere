import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";

// Route-level test for the PATCH /api/articles/[id] restricted-tags path.
// Mirrors import-route-validation.test.ts: it needs a reachable DATABASE_URL
// and the local dev stack, and exercises the real route handler end-to-end.
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable must be set for tests");
}

const TEST_PREFIX = "test-issue182-";
const TEST_SCOPE_OWNED = `${TEST_PREFIX}owned`;
const TEST_SCOPE_FORBIDDEN = `${TEST_PREFIX}forbidden`;
const TEST_TOPIC_SLUG = `${TEST_PREFIX}topic`;
const TEST_KEY_NAME = `${TEST_PREFIX}key`;
const TEST_CLIENT_IP = `10.77.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

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

async function upsertScopedWriteKey(
  prisma: PrismaClient,
  rawKey: string,
  allowedScopes: string[],
): Promise<void> {
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  const keyPrefix = rawKey.slice(0, 8);
  const existingKey = await prisma.apiKey.findFirst({
    where: { name: TEST_KEY_NAME },
  });
  if (existingKey) {
    await prisma.apiKey.update({
      where: { id: existingKey.id },
      data: { keyHash, keyPrefix, permissions: "WRITE", allowedScopes },
    });
  } else {
    await prisma.apiKey.create({
      data: {
        name: TEST_KEY_NAME,
        keyHash,
        keyPrefix,
        permissions: "WRITE",
        allowedScopes,
      },
    });
  }
}

async function setupSharedFixtures(prisma: PrismaClient): Promise<void> {
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
    create: { name: "Test Patch Validation", slug: TEST_TOPIC_SLUG },
    update: {},
  });
}

async function cleanupSharedFixtures(prisma: PrismaClient): Promise<void> {
  await prisma.article.deleteMany({
    where: { topic: { slug: TEST_TOPIC_SLUG } },
  });
  await prisma.topic.deleteMany({ where: { slug: TEST_TOPIC_SLUG } });
  await prisma.apiKey.deleteMany({ where: { name: TEST_KEY_NAME } });
  await prisma.restrictedScope.deleteMany({
    where: { tag: { in: [TEST_SCOPE_OWNED, TEST_SCOPE_FORBIDDEN] } },
  });
}

async function createArticle(
  prisma: PrismaClient,
  slug: string,
  restrictedTags: string[] = [],
) {
  const topic = await prisma.topic.findUnique({
    where: { slug: TEST_TOPIC_SLUG },
  });
  assert.ok(topic, "shared topic must exist");
  return prisma.article.create({
    data: {
      title: `Patch Test ${slug}`,
      slug,
      content: "# Patch restricted-tags test",
      topicId: topic.id,
      authorName: TEST_KEY_NAME,
      restrictedTags,
    },
  });
}

// ─── Issue #182: PATCH must reject restrictedTags the caller cannot assign ──

test("PATCH /api/articles/[id] rejects restrictedTags the caller cannot assign (issue #182)", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { PATCH } = await import("@/app/api/articles/[id]/route");

  await setupSharedFixtures(prisma);

  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;
  await upsertScopedWriteKey(prisma, rawKey, [TEST_SCOPE_OWNED]);

  const article = await createArticle(prisma, "patch-unauthorized");

  try {
    const response = await PATCH(
      buildPatchRequest(article.id, { restrictedTags: [TEST_SCOPE_FORBIDDEN] }, rawKey),
      { params: Promise.resolve({ id: article.id }) },
    );
    const body = (await response.json()) as { error?: string };

    assert.equal(response.status, 403, "non-admin key must be forbidden from assigning a scope it lacks");
    assert.ok(body.error, "response should include an error message");
    assert.ok(
      body.error!.includes(TEST_SCOPE_FORBIDDEN),
      `error should mention the forbidden scope, got: ${body.error}`,
    );

    // The article must be unchanged.
    const after = await prisma.article.findUnique({ where: { id: article.id } });
    assert.ok(after, "article must still exist");
    assert.deepEqual(
      after!.restrictedTags,
      [],
      "unauthorized PATCH must not mutate restrictedTags",
    );
  } finally {
    await cleanupSharedFixtures(prisma);
  }
});

test("PATCH /api/articles/[id] accepts restrictedTags the caller can assign", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { PATCH } = await import("@/app/api/articles/[id]/route");

  await setupSharedFixtures(prisma);

  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;
  await upsertScopedWriteKey(prisma, rawKey, [TEST_SCOPE_OWNED]);

  const article = await createArticle(prisma, "patch-authorized");

  try {
    const response = await PATCH(
      buildPatchRequest(article.id, { restrictedTags: [TEST_SCOPE_OWNED] }, rawKey),
      { params: Promise.resolve({ id: article.id }) },
    );
    const body = (await response.json()) as { restrictedTags?: string[] };

    assert.equal(response.status, 200, "authorized PATCH should succeed");
    assert.deepEqual(
      body.restrictedTags,
      [TEST_SCOPE_OWNED],
      "restrictedTags should be persisted",
    );
  } finally {
    await cleanupSharedFixtures(prisma);
  }
});

test("PATCH /api/articles/[id] declassifies on explicit empty restrictedTags (no auto-assign)", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { PATCH } = await import("@/app/api/articles/[id]/route");

  await setupSharedFixtures(prisma);

  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;
  // Key owns the scope the article is already classified under, so it can access it.
  await upsertScopedWriteKey(prisma, rawKey, [TEST_SCOPE_OWNED]);

  const article = await createArticle(prisma, "patch-declassify", [TEST_SCOPE_OWNED]);

  try {
    const response = await PATCH(
      buildPatchRequest(article.id, { restrictedTags: [] }, rawKey),
      { params: Promise.resolve({ id: article.id }) },
    );
    const body = (await response.json()) as { restrictedTags?: string[] };

    assert.equal(response.status, 200, "explicit [] should declassify");
    assert.deepEqual(
      body.restrictedTags,
      [],
      "empty array must declassify, not auto-inherit the caller's scopes",
    );
  } finally {
    await cleanupSharedFixtures(prisma);
  }
});
