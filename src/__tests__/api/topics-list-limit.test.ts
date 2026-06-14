import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { NextRequest } from "next/server";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable must be set for tests");
}

const TOPIC_TREE_MAX_TOPICS = 500;
const TEST_PREFIX = "test-issue144-";
const TEST_CLIENT_IP = `10.78.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

function buildGetRequest(rawKey: string): NextRequest {
  const request = new Request("http://localhost/api/topics", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${rawKey}`,
      "x-real-ip": TEST_CLIENT_IP,
    },
  });
  return request as unknown as NextRequest;
}

test("GET /api/topics rejects oversized trees instead of returning a partial hierarchy (issue #144)", async () => {
  const { prisma } = await import("@/lib/prisma");
  const { GET } = await import("@/app/api/topics/route");
  const runId = crypto.randomUUID();
  const rawKey = `noo_${crypto.randomBytes(32).toString("base64url")}`;
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

  const apiKey = await prisma.apiKey.create({
    data: {
      name: `${TEST_PREFIX}${runId}`,
      keyHash,
      keyPrefix: rawKey.slice(0, 8),
      permissions: "READ",
      allowedScopes: ["*"],
    },
  });

  try {
    const initialCount = await prisma.topic.count();
    if (initialCount <= TOPIC_TREE_MAX_TOPICS) {
      const normalResponse = await GET(buildGetRequest(rawKey));
      const normalBody = (await normalResponse.json()) as { topics?: unknown[] };
      assert.equal(normalResponse.status, 200);
      assert.ok(Array.isArray(normalBody.topics), "normal datasets should retain the topic-tree response");

      const topicsNeeded = TOPIC_TREE_MAX_TOPICS + 1 - initialCount;
      await prisma.topic.createMany({
        data: Array.from({ length: topicsNeeded }, (_, index) => ({
          name: `${TEST_PREFIX}${runId}-${index}`,
          slug: `${TEST_PREFIX}${runId}-${index}`,
        })),
      });
    }

    await prisma.apiKey.update({
      where: { id: apiKey.id },
      data: { allowedScopes: [] },
    });
    const scopedResponse = await GET(buildGetRequest(rawKey));
    const scopedBody = (await scopedResponse.json()) as { topics?: unknown[] };
    assert.equal(scopedResponse.status, 200, "hidden topics must not count against a scoped caller");
    assert.ok(Array.isArray(scopedBody.topics));
    assert.equal(
      JSON.stringify(scopedBody.topics).includes(`${TEST_PREFIX}${runId}`),
      false,
      "empty topics outside the caller's visible tree must remain hidden",
    );

    await prisma.apiKey.update({
      where: { id: apiKey.id },
      data: { allowedScopes: ["*"] },
    });

    const overflowResponse = await GET(buildGetRequest(rawKey));
    const overflowBody = (await overflowResponse.json()) as {
      error?: string;
      code?: string;
      maxTopics?: number;
      topics?: unknown[];
    };

    assert.equal(overflowResponse.status, 409);
    assert.equal(overflowBody.code, "TOPIC_TREE_LIMIT_EXCEEDED");
    assert.equal(overflowBody.maxTopics, TOPIC_TREE_MAX_TOPICS);
    assert.equal(overflowBody.topics, undefined, "overflow must not expose a partial topic tree");
    assert.match(overflowBody.error ?? "", /supported limit of 500 topics/);
  } finally {
    await prisma.topic.deleteMany({
      where: { slug: { startsWith: `${TEST_PREFIX}${runId}` } },
    });
    await prisma.apiKey.delete({ where: { id: apiKey.id } });
  }
});
