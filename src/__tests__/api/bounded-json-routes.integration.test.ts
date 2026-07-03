import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  DEFAULT_JSON_BODY_MAX_BYTES,
  MAX_JSON_DEPTH,
} from "@/lib/api/body";
import { ARTICLE_LIMITS } from "@/lib/validation";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable must be set for tests");
}

const TEST_PREFIX = "test-issue192-";
const TEST_CLIENT_IP = `10.92.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

function buildRequest(
  rawKey: string,
  pathname: string,
  body?: string,
  method = "POST",
): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${rawKey}`,
      "Content-Type": "application/json",
      "x-real-ip": TEST_CLIENT_IP,
    },
    body,
  });
}

test("legacy JSON routes enforce size and nesting limits (issue #192)", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { POST: lint } = await import("@/app/api/lint/route");
  const { POST: createArticle } = await import("@/app/api/articles/route");
  const { PATCH: updateKey } = await import("@/app/api/keys/[id]/route");
  const runId = crypto.randomUUID();
  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

  const apiKey = await prisma.apiKey.create({
    data: {
      name: `${TEST_PREFIX}${runId}`,
      keyHash,
      keyPrefix: rawKey.slice(0, 8),
      permissions: "ADMIN",
      allowedScopes: ["*"],
    },
  });

  try {
    const emptyResponse = await lint(buildRequest(rawKey, "/api/lint"));
    assert.equal(emptyResponse.status, 200);

    const malformedResponse = await lint(
      buildRequest(rawKey, "/api/lint", "not-json"),
    );
    assert.equal(malformedResponse.status, 400);
    assert.equal(
      ((await malformedResponse.json()) as { error: string }).error,
      "Invalid JSON body",
    );

    const nullObjectResponse = await updateKey(
      buildRequest(rawKey, `/api/keys/${apiKey.id}`, "null", "PATCH"),
      { params: Promise.resolve({ id: apiKey.id }) },
    );
    assert.equal(nullObjectResponse.status, 400);
    assert.equal(
      ((await nullObjectResponse.json()) as { error: string }).error,
      "Invalid JSON body",
    );

    const oversizedDefaultBody = JSON.stringify({
      padding: "x".repeat(DEFAULT_JSON_BODY_MAX_BYTES),
    });
    const oversizedResponse = await lint(
      buildRequest(rawKey, "/api/lint", oversizedDefaultBody),
    );
    assert.equal(oversizedResponse.status, 413);
    assert.equal(
      ((await oversizedResponse.json()) as { error: string }).error,
      "Request body is too large",
    );

    const deeplyNestedBody = `${'{"nested":'.repeat(MAX_JSON_DEPTH + 1)}0${"}".repeat(MAX_JSON_DEPTH + 1)}`;
    const nestedResponse = await lint(
      buildRequest(rawKey, "/api/lint", deeplyNestedBody),
    );
    assert.equal(nestedResponse.status, 413);
    assert.equal(
      ((await nestedResponse.json()) as { error: string }).error,
      "JSON nesting depth exceeds limit",
    );

    const validLargeArticleBody = JSON.stringify({
      title: "Large article",
      slug: `large-article-${runId}`,
      content: "x".repeat(DEFAULT_JSON_BODY_MAX_BYTES + 1),
      topicId: `missing-${runId}`,
    });
    const validLargeResponse = await createArticle(
      buildRequest(rawKey, "/api/articles", validLargeArticleBody),
    );
    assert.equal(validLargeResponse.status, 404);

    const oversizedArticleBody = JSON.stringify({
      // One byte beyond the route's documented content-plus-metadata allowance
      // makes this a body-reader boundary assertion, not content validation.
      content: "x".repeat(
        ARTICLE_LIMITS.maxContentSize + DEFAULT_JSON_BODY_MAX_BYTES + 1,
      ),
    });
    const oversizedArticleResponse = await createArticle(
      buildRequest(rawKey, "/api/articles", oversizedArticleBody),
    );
    assert.equal(oversizedArticleResponse.status, 413);
  } finally {
    const expectedAuthorName = `${TEST_PREFIX}${runId}`;
    const auditLogs = await prisma.activityLog.findMany({
      where: { authorName: expectedAuthorName },
      select: { authorName: true, type: true },
    });
    const deletedLogs = await prisma.activityLog.deleteMany({
      where: { authorName: expectedAuthorName },
    });
    await prisma.apiKey.delete({ where: { id: apiKey.id } });

    // Exactly one log is expected here: the empty-body lint success at the start.
    assert.deepEqual(auditLogs, [{ authorName: expectedAuthorName, type: "lint" }]);
    assert.equal(deletedLogs.count, 1);
  }
});

test("article PATCH rejects oversized request bodies", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { PATCH: updateArticle } = await import("@/app/api/articles/[id]/route");
  const runId = crypto.randomUUID();
  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

  const apiKey = await prisma.apiKey.create({
    data: {
      name: `${TEST_PREFIX}${runId}`,
      keyHash,
      keyPrefix: rawKey.slice(0, 8),
      permissions: "ADMIN",
      allowedScopes: ["*"],
    },
  });

  try {
    const topic = await prisma.topic.create({
      data: {
        name: `${TEST_PREFIX}${runId}`,
        slug: `${TEST_PREFIX}${runId}`,
      },
    });
    const article = await prisma.article.create({
      data: {
        title: `${TEST_PREFIX}${runId}`,
        slug: `${TEST_PREFIX}${runId}`,
        content: "Original content",
        topicId: topic.id,
      },
    });
    const oversizedArticlePatchBody = JSON.stringify({
      content: "x".repeat(
        ARTICLE_LIMITS.maxContentSize + DEFAULT_JSON_BODY_MAX_BYTES + 1,
      ),
    });
    const response = await updateArticle(
      buildRequest(
        rawKey,
        `/api/articles/${article.id}`,
        oversizedArticlePatchBody,
        "PATCH",
      ),
      { params: Promise.resolve({ id: article.id }) },
    );
    assert.equal(response.status, 413);
  } finally {
    await prisma.activityLog.deleteMany({
      where: { authorName: `${TEST_PREFIX}${runId}` },
    });
    await prisma.article.deleteMany({
      where: { slug: `${TEST_PREFIX}${runId}` },
    });
    await prisma.topic.deleteMany({
      where: { slug: `${TEST_PREFIX}${runId}` },
    });
    await prisma.apiKey.delete({ where: { id: apiKey.id } });
  }
});
