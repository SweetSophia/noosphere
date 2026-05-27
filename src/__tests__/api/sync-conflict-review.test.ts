import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { prisma } from "@/lib/prisma";
import {
  recordSyncConflictReview,
  resolveSyncConflictReview,
  SyncConflictReviewClosedError,
} from "@/lib/markdown-sync/api/conflict-review";
import { runObsidianSync } from "@/lib/obsidian-sync";
import {
  buildSyncConflictReviewCreateInput,
  buildSyncConflictReviewSummary,
  isSyncConflictReviewAction,
  resolveVaultArchivePath,
  statusForSyncConflictReviewAction,
} from "@/lib/markdown-sync/conflict-review";

const article = {
  id: "article-1",
  title: "Noosphere Source",
  slug: "noosphere-source",
  updatedAt: new Date("2026-05-26T10:00:00.000Z"),
  status: "published",
  confidence: "high",
  topic: { slug: "projects", name: "Projects" },
  tags: [{ tag: { slug: "sync", name: "Sync" } }],
};

const markdown = `---
title: Markdown Source
slug: markdown-source
topic: projects
status: reviewed
confidence: medium
tags:
  - sync
  - local
updatedAt: "2026-05-26T11:00:00.000Z"
noosphere:
  entity: article
  schemaVersion: 1
  syncedAt: "2026-05-26T11:30:00.000Z"
---

Local markdown copy.
`;

test("sync conflict review actions map to terminal statuses", () => {
  assert.equal(isSyncConflictReviewAction("keep-noosphere"), true);
  assert.equal(isSyncConflictReviewAction("keep-markdown"), true);
  assert.equal(isSyncConflictReviewAction("delete-everything"), false);

  assert.equal(statusForSyncConflictReviewAction("keep-noosphere"), "resolved");
  assert.equal(statusForSyncConflictReviewAction("keep-markdown"), "resolved");
  assert.equal(statusForSyncConflictReviewAction("mark-resolved"), "resolved");
  assert.equal(statusForSyncConflictReviewAction("ignore-once"), "ignored-once");
  assert.equal(statusForSyncConflictReviewAction("ignore-always"), "ignored-always");
});

test("buildSyncConflictReviewSummary extracts comparable metadata", () => {
  const summary = buildSyncConflictReviewSummary(article, markdown, "database-hash");

  assert.equal(summary.noosphere.title, "Noosphere Source");
  assert.equal(summary.noosphere.contentHash, "database-hash");
  assert.equal(summary.markdown.title, "Markdown Source");
  assert.equal(summary.markdown.slug, "markdown-source");
  assert.deepEqual(summary.markdown.tags, ["sync", "local"]);
  assert.equal(summary.markdown.parseError, null);
  assert.equal(typeof summary.markdown.contentHash, "string");
});

test("buildSyncConflictReviewCreateInput prepares vault-to-noosphere review rows", () => {
  const input = buildSyncConflictReviewCreateInput({
    article,
    direction: "vault-to-noosphere",
    relativePath: "projects/noosphere-source.md",
    archivePath: ".noosphere-sync/conflicts/2026-projects---noosphere-source.md",
    noosphereHash: "database-hash",
    markdownContent: markdown,
  });

  assert.equal(input.articleId, "article-1");
  assert.equal(input.direction, "vault-to-noosphere");
  assert.equal(input.relativePath, "projects/noosphere-source.md");
  assert.equal(input.summary.markdown.title, "Markdown Source");
  assert.equal(input.markdownUpdatedAt?.toISOString(), "2026-05-26T11:00:00.000Z");
});

test("recordSyncConflictReview suppresses exact ignored-always conflicts", async () => {
  const input = buildSyncConflictReviewCreateInput({
    article,
    direction: "vault-to-noosphere",
    relativePath: "projects/noosphere-source.md",
    archivePath: ".noosphere-sync/conflicts/2026-projects---noosphere-source.md",
    noosphereHash: "database-hash",
    markdownContent: markdown,
  });
  const delegate = prisma.syncConflictReview as unknown as {
    findFirst: (args: unknown) => Promise<unknown>;
    create: (args: unknown) => Promise<unknown>;
  };
  const originalFindFirst = delegate.findFirst;
  const originalCreate = delegate.create;
  let findFirstCalls = 0;
  let createCalls = 0;

  try {
    delegate.findFirst = async (args: unknown) => {
      findFirstCalls++;
      assert.deepEqual(args, {
        where: {
          articleId: "article-1",
          direction: "vault-to-noosphere",
          relativePath: "projects/noosphere-source.md",
          markdownHash: input.markdownHash,
          status: "ignored-always",
        },
        orderBy: [{ resolvedAt: "desc" }, { createdAt: "desc" }],
      });
      return { id: "ignored-review", status: "ignored-always" };
    };
    delegate.create = async () => {
      createCalls++;
      throw new Error("create should not run for ignored-always conflicts");
    };

    const review = await recordSyncConflictReview(input);

    assert.equal((review as { id: string }).id, "ignored-review");
    assert.equal(findFirstCalls, 1);
    assert.equal(createCalls, 0);
  } finally {
    delegate.findFirst = originalFindFirst;
    delegate.create = originalCreate;
  }
});

test("resolveSyncConflictReview rejects already terminal reviews", async () => {
  const tx = {
    syncConflictReview: {
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => ({ status: "ignored-always" }),
    },
    activityLog: {
      create: async () => {
        throw new Error("activity log should not be written for terminal reviews");
      },
    },
  };
  type TransactionStub = typeof tx;
  const client = prisma as unknown as {
    $transaction: <T>(fn: (tx: TransactionStub) => Promise<T>) => Promise<T>;
  };
  const originalTransaction = client.$transaction;

  try {
    client.$transaction = async (fn) => fn(tx);

    await assert.rejects(
      () =>
        resolveSyncConflictReview({
          id: "review-1",
          action: "keep-noosphere",
          resolvedBy: "Admin",
        }),
      SyncConflictReviewClosedError,
    );
  } finally {
    client.$transaction = originalTransaction;
  }
});

test("runObsidianSync keeps local markdown visible when conflict review persistence fails", async () => {
  const vaultPath = `/tmp/noosphere-conflict-review-${Date.now()}-${process.pid}`;
  const oldEnabled = process.env.OBSIDIAN_SYNC_ENABLED;
  const oldVaultPath = process.env.OBSIDIAN_SYNC_VAULT_PATH;
  const oldPreserve = process.env.OBSIDIAN_SYNC_PRESERVE_LOCAL_CHANGES;
  const relativePath = "projects/noosphere-source.md";
  const localMarkdown = "# Local-only markdown";

  try {
    process.env.OBSIDIAN_SYNC_ENABLED = "true";
    process.env.OBSIDIAN_SYNC_VAULT_PATH = vaultPath;
    process.env.OBSIDIAN_SYNC_PRESERVE_LOCAL_CHANGES = "true";

    mkdirSync(join(vaultPath, "projects"), { recursive: true });
    mkdirSync(join(vaultPath, ".noosphere-sync"), { recursive: true });
    writeFileSync(join(vaultPath, relativePath), localMarkdown, "utf-8");
    writeFileSync(
      join(vaultPath, ".noosphere-sync", "manifest.json"),
      JSON.stringify({
        version: 1,
        vaultPath,
        lastRunAt: "2026-05-26T00:00:00.000Z",
        articles: {
          "article-1": {
            path: relativePath,
            updatedAt: "2026-05-26T09:00:00.000Z",
            contentHash: "previous-noosphere-hash",
            writtenHash: createHash("sha256").update("# Previous noosphere markdown").digest("hex"),
            deletedAt: null,
          },
        },
      }),
      "utf-8",
    );

    const topic = { id: "topic-1", slug: "projects", parentId: null, name: "Projects" };
    const syncArticle = {
      ...article,
      content: "# Noosphere markdown",
      excerpt: null,
      sourceUrl: null,
      sourceType: null,
      lastReviewed: null,
      createdAt: new Date("2026-05-26T08:00:00.000Z"),
      topicId: "topic-1",
      topic,
      tags: [],
    };

    const client = prisma as unknown as { $queryRaw: () => Promise<unknown> };
    const originalQueryRaw = client.$queryRaw;
    const originalTopicFindMany = prisma.topic.findMany;
    const originalArticleFindMany = prisma.article.findMany;
    const originalConflictFindFirst = prisma.syncConflictReview.findFirst;
    const originalConflictCreate = prisma.syncConflictReview.create;
    const originalActivityLogCreate = prisma.activityLog.create;
    const originalConsoleError = console.error;

    client.$queryRaw = async () => [{ acquire: true }];
    prisma.topic.findMany = async () => [topic];
    prisma.article.findMany = async () => [syncArticle];
    prisma.syncConflictReview.findFirst = async () => null;
    prisma.syncConflictReview.create = async () => {
      throw new Error("database unavailable");
    };
    prisma.activityLog.create = async () => ({});
    console.error = () => {};

    try {
      const result = await runObsidianSync({ mode: "full", clean: false, git: false, dryRun: false });

      assert.equal(readFileSync(join(vaultPath, relativePath), "utf-8"), localMarkdown);
      assert.equal(result.stats.skipped, 1);
      assert.equal(result.stats.written, 0);
      assert.equal(
        result.warnings.some((warning) => warning.includes("Conflict review record failed; sync skipped")),
        true,
      );
      assert.equal(existsSync(join(vaultPath, ".noosphere-sync", "conflicts")), true);
    } finally {
      client.$queryRaw = originalQueryRaw;
      prisma.topic.findMany = originalTopicFindMany;
      prisma.article.findMany = originalArticleFindMany;
      prisma.syncConflictReview.findFirst = originalConflictFindFirst;
      prisma.syncConflictReview.create = originalConflictCreate;
      prisma.activityLog.create = originalActivityLogCreate;
      console.error = originalConsoleError;
    }
  } finally {
    if (oldEnabled === undefined) delete process.env.OBSIDIAN_SYNC_ENABLED;
    else process.env.OBSIDIAN_SYNC_ENABLED = oldEnabled;
    if (oldVaultPath === undefined) delete process.env.OBSIDIAN_SYNC_VAULT_PATH;
    else process.env.OBSIDIAN_SYNC_VAULT_PATH = oldVaultPath;
    if (oldPreserve === undefined) delete process.env.OBSIDIAN_SYNC_PRESERVE_LOCAL_CHANGES;
    else process.env.OBSIDIAN_SYNC_PRESERVE_LOCAL_CHANGES = oldPreserve;
    rmSync(vaultPath, { recursive: true, force: true });
  }
});

test("resolveVaultArchivePath only allows archived conflict files", () => {
  const vaultPath = "/vault";

  assert.equal(
    resolveVaultArchivePath(vaultPath, ".noosphere-sync/conflicts/2026-file.md"),
    "/vault/.noosphere-sync/conflicts/2026-file.md",
  );
  assert.equal(resolveVaultArchivePath(vaultPath, "../etc/passwd"), null);
  assert.equal(resolveVaultArchivePath(vaultPath, ".noosphere-sync/manifest.json"), null);
});
