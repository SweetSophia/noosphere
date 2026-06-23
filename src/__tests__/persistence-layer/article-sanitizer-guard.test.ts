/**
 * Regression test for issue #213: persistence-layer article sanitizer guard.
 *
 * This test proves that a direct `prisma.article.create()` call (bypassing all
 * route-level sanitization) is still protected against injected-memory blocks
 * by the Prisma client extension.
 *
 * The test uses the real database because the extension is applied at the
 * PrismaClient instance level and cannot be reliably mocked.
 *
 * Requires DATABASE_URL pointing at a reachable PostgreSQL instance.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { prisma } from "@/lib/prisma";
import { PERSISTENCE_LAYER_INJECTED_ONLY_ERROR } from "@/lib/prisma-extensions/article-sanitizer";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable must be set for tests");
}

const TEST_RUN_ID = crypto.randomUUID();
const TEST_PREFIX = `test-issue213-${TEST_RUN_ID}`;

async function ensureTestTopic() {
  const slug = `${TEST_PREFIX}-topic`;
  const topic = await prisma.topic.upsert({
    where: { slug },
    create: { name: `${TEST_PREFIX} Topic`, slug },
    update: {},
  });
  return topic;
}

async function cleanupTestFixtures() {
  await prisma.article.deleteMany({
    where: { title: { contains: TEST_PREFIX } },
  });
  await prisma.topic.deleteMany({
    where: { slug: { contains: TEST_PREFIX } },
  });
}

test("persistence layer strips injected-memory blocks from direct article.create", async () => {
  const topic = await ensureTestTopic();
  const title = `${TEST_PREFIX}-create-strip`;

  try {
    const created = await prisma.article.create({
      data: {
        title,
        slug: `${TEST_PREFIX}-create-strip`,
        topicId: topic.id,
        content:
          "Visible durable content.\n<recall>secret recall data</recall>\nMore visible content.",
        excerpt:
          "Visible excerpt.\n<hindsight_memories>hidden memory</hindsight_memories>",
      },
    });

    // The injected blocks must be stripped before persistence
    assert.ok(
      !created.content.includes("<recall>"),
      "content must not contain <recall> blocks",
    );
    assert.ok(
      !created.content.includes("secret recall data"),
      "content must not contain stripped block content",
    );
    assert.ok(
      created.content.includes("Visible durable content."),
      "content must preserve durable text",
    );

    assert.ok(
      !created.excerpt?.includes("<hindsight_memories>"),
      "excerpt must not contain <hindsight_memories> blocks",
    );
    assert.ok(
      created.excerpt?.includes("Visible excerpt."),
      "excerpt must preserve durable text",
    );
  } finally {
    await cleanupTestFixtures();
  }
});

test("persistence layer rejects article.create with injected-only content", async () => {
  const topic = await ensureTestTopic();

  try {
    await assert.rejects(
      () =>
        prisma.article.create({
          data: {
            title: `${TEST_PREFIX}-create-reject`,
            slug: `${TEST_PREFIX}-create-reject`,
            topicId: topic.id,
            content: "<recall>only injected content, no durable text</recall>",
          },
        }),
      (err: Error) => {
        assert.ok(
          err.message.includes(PERSISTENCE_LAYER_INJECTED_ONLY_ERROR),
          `error should mention persistence layer rejection, got: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    await cleanupTestFixtures();
  }
});

test("persistence layer strips injected-memory blocks from direct article.update", async () => {
  const topic = await ensureTestTopic();

  // First create a clean article
  const article = await prisma.article.create({
    data: {
      title: `${TEST_PREFIX}-update-strip`,
      slug: `${TEST_PREFIX}-update-strip`,
      topicId: topic.id,
      content: "Original clean content.",
    },
  });

  try {
    const updated = await prisma.article.update({
      where: { id: article.id },
      data: {
        content:
          "Updated visible content.\n<noosphere_auto_recall>injected auto-recall</noosphere_auto_recall>\nMore visible.",
      },
    });

    assert.ok(
      !updated.content.includes("<noosphere_auto_recall>"),
      "updated content must not contain injected blocks",
    );
    assert.ok(
      updated.content.includes("Updated visible content."),
      "updated content must preserve durable text",
    );
  } finally {
    await cleanupTestFixtures();
  }
});

test("persistence layer rejects article.update with injected-only content", async () => {
  const topic = await ensureTestTopic();

  // Create a clean article first
  const article = await prisma.article.create({
    data: {
      title: `${TEST_PREFIX}-update-reject`,
      slug: `${TEST_PREFIX}-update-reject`,
      topicId: topic.id,
      content: "Original clean content for update-reject test.",
    },
  });

  try {
    await assert.rejects(
      () =>
        prisma.article.update({
          where: { id: article.id },
          data: {
            content:
              "<hindsight_memories>only injected, replaces all durable text</hindsight_memories>",
          },
        }),
      (err: Error) => {
        assert.ok(
          err.message.includes(PERSISTENCE_LAYER_INJECTED_ONLY_ERROR),
          `error should mention persistence layer rejection, got: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    await cleanupTestFixtures();
  }
});

test("persistence layer does not interfere with updateMany (metadata-only update)", async () => {
  const topic = await ensureTestTopic();

  const article = await prisma.article.create({
    data: {
      title: `${TEST_PREFIX}-updatemany`,
      slug: `${TEST_PREFIX}-updatemany`,
      topicId: topic.id,
      content: "Clean content for updateMany test.",
      status: "published",
    },
  });

  try {
    // updateMany is used for bulk metadata updates (publish/unpublish)
    // and should NOT be intercepted by the sanitizer
    const result = await prisma.article.updateMany({
      where: { id: article.id },
      data: { status: "draft" },
    });

    assert.equal(result.count, 1, "updateMany should succeed for metadata-only update");
  } finally {
    await cleanupTestFixtures();
  }
});

test("persistence layer strips injected blocks from nested revision.create inside article.create", async () => {
  const topic = await ensureTestTopic();

  try {
    // Article create with nested revision that contains injected blocks in its content
    const created = await prisma.article.create({
      data: {
        title: `${TEST_PREFIX}-nested-revision`,
        slug: `${TEST_PREFIX}-nested-revision`,
        topicId: topic.id,
        content: "Clean article content for nested revision test.",
        revisions: {
          create: {
            title: `${TEST_PREFIX}-nested-revision-r1`,
            content:
              "Revision content.\n<recall>injected in revision</recall>\nEnd.",
          },
        },
      },
      include: { revisions: true },
    });

    // The revision content should also be stripped
    const revision = created.revisions[0];
    assert.ok(
      !revision.content.includes("<recall>"),
      "nested revision content must not contain injected blocks",
    );
    assert.ok(
      revision.content.includes("Revision content."),
      "nested revision content must preserve durable text",
    );
  } finally {
    await cleanupTestFixtures();
  }
});
