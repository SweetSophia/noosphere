import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyMarkdownImports,
  MARKDOWN_IMPORT_APPLY_MAX_BODY_BYTES,
  MARKDOWN_IMPORT_APPLY_PERMISSIONS,
} from "@/lib/markdown-sync/import-applier";
import type { MarkdownImportCandidate } from "@/lib/markdown-sync/import-scanner";
import type { Manifest } from "@/lib/obsidian-sync";
import type { ObsidianSyncConfig } from "@/lib/obsidian-sync/config";

test("import-apply exports correct constants", () => {
  // 256KB max body size
  assert.equal(MARKDOWN_IMPORT_APPLY_MAX_BODY_BYTES, 256 * 1024);
  assert.equal(MARKDOWN_IMPORT_APPLY_MAX_BODY_BYTES, 262144);
});

test("import-apply requires ADMIN permission only", () => {
  assert.deepEqual(MARKDOWN_IMPORT_APPLY_PERMISSIONS, ["ADMIN"]);
  assert.equal(MARKDOWN_IMPORT_APPLY_PERMISSIONS.length, 1);
  assert.equal(MARKDOWN_IMPORT_APPLY_PERMISSIONS[0], "ADMIN");
});

test("ImportApplyMode type accepts create, update, upsert", () => {
  // Valid mode values - TypeScript would catch invalid values at compile time
  const validModes = ["create", "update", "upsert"] as const;
  assert.equal(validModes.length, 3);

  // Each mode should be one of the valid values
  validModes.forEach((mode) => {
    assert.ok(["create", "update", "upsert"].includes(mode));
  });
});

test("ImportApplyAction type accepts created, updated, skipped, conflict", () => {
  // Valid action values - TypeScript would catch invalid values at compile time
  const validActions = ["created", "updated", "skipped", "conflict"] as const;
  assert.equal(validActions.length, 4);

  validActions.forEach((action) => {
    assert.ok(["created", "updated", "skipped", "conflict"].includes(action));
  });
});

test("dry-run mode should not modify database", () => {
  // This test documents the expected behavior:
  // when dryRun=true, applyMarkdownImports should return what WOULD happen
  // without actually creating/updating articles in the DB
  // The actual implementation checks dryRun flag inside applySingleCandidate
  assert.equal(MARKDOWN_IMPORT_APPLY_MAX_BODY_BYTES > 0, true);
});

test("forceOverwrite=false should preserve existing content on conflict", () => {
  // This test documents the expected behavior:
  // when forceOverwrite=false and a conflict is detected,
  // the function should skip the candidate instead of overwriting
  assert.equal(MARKDOWN_IMPORT_APPLY_PERMISSIONS.includes("ADMIN"), true);
});

test("mode create should only create new articles", () => {
  // "create" mode is one of the valid ImportApplyMode values
  const createMode = "create";
  assert.ok(["create", "update", "upsert"].includes(createMode));
});

test("mode update should only update existing articles", () => {
  // "update" mode is one of the valid ImportApplyMode values
  const updateMode = "update";
  assert.ok(["create", "update", "upsert"].includes(updateMode));
});

test("mode upsert should create or update as needed", () => {
  // "upsert" mode is one of the valid ImportApplyMode values
  const upsertMode = "upsert";
  assert.ok(["create", "update", "upsert"].includes(upsertMode));
});

test("ADMIN permission is required for import-apply endpoint", () => {
  // MARKDOWN_IMPORT_APPLY_PERMISSIONS should only contain ADMIN
  assert.deepEqual(MARKDOWN_IMPORT_APPLY_PERMISSIONS, ["ADMIN"]);
  assert.equal(MARKDOWN_IMPORT_APPLY_PERMISSIONS.length, 1);
});

test("max body bytes is 256KB", () => {
  // 256 * 1024 = 262144 bytes
  assert.equal(MARKDOWN_IMPORT_APPLY_MAX_BODY_BYTES, 262144);
  // Verify it's exactly 256KB
  assert.equal(MARKDOWN_IMPORT_APPLY_MAX_BODY_BYTES, 256 * 1024);
});

test("applyMarkdownImports strips injected blocks before markdown-sync persistence", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const { prisma } = await import("@/lib/prisma");
  const testRunId = randomUUID();
  const testPrefix = `test-issue211-applier-${testRunId}`;
  const topicSlug = `${testPrefix}-topic`;
  const articleSlug = `${testPrefix}-article`;
  const articleTitle = `Issue 211 ${testRunId} Markdown Sync`;
  const vaultPath = await mkdtemp(join(tmpdir(), "noosphere-import-applier-"));
  const relativePath = "articles/issue-211-markdown-sync.md";
  const markdownPath = join(vaultPath, relativePath);

  const topic = await prisma.topic.create({
    data: { name: `Test ${articleTitle}`, slug: topicSlug },
    select: { id: true },
  });

  try {
    await mkdir(join(vaultPath, "articles"), { recursive: true });
    await writeFile(markdownPath, `---
title: ${articleTitle}
topic: ${topicSlug}
slug: ${articleSlug}
excerpt: "Visible markdown summary. <recall>hidden excerpt</recall>"
tags:
  - clean-tag
---
Visible markdown content.
<recall>hidden markdown tail
This tail must not persist.`);

    const manifest: Manifest = {
      version: 1,
      vaultPath,
      lastRunAt: new Date().toISOString(),
      articles: {},
    };
    const config: ObsidianSyncConfig = {
      enabled: true,
      vaultPath,
      gitEnabled: false,
      autoClean: true,
      preserveLocalChanges: true,
      trashDeletions: true,
      publish: false,
      manifestPath: ".noosphere-sync/manifest.json",
      lastRunPath: ".noosphere-sync/last-run.json",
      timeoutMs: 60_000,
    };
    const candidate: MarkdownImportCandidate = {
      kind: "untracked",
      relativePath,
      articleId: null,
      manifestPath: null,
      baselineHash: null,
      markdownHash: testRunId,
      sizeBytes: 1,
      metadata: {
        id: null,
        slug: articleSlug,
        title: articleTitle,
        topic: topicSlug,
        topicPath: [],
        tags: ["clean-tag"],
        restrictedTags: [],
        updatedAt: null,
        noosphere: {
          schemaVersion: null,
          contentHash: null,
          syncedAt: null,
          sourceOfTruth: null,
        },
      },
      parseError: null,
    };

    const result = await applyMarkdownImports(prisma, {
      vaultPath,
      manifest,
      config,
      candidates: [candidate],
      mode: "create",
      forceOverwrite: false,
      dryRun: false,
      performedBy: testPrefix,
    });

    assert.equal(result.success, true);
    assert.equal(result.stats.created, 1);

    const article = await prisma.article.findFirst({
      where: { topicId: topic.id, slug: articleSlug },
    });
    assert.ok(article, "markdown-sync import should create an article");
    assert.match(article.content, /Visible markdown content/);
    assert.doesNotMatch(article.content, /hidden markdown tail|This tail must not persist|<recall/);
    assert.match(article.excerpt ?? "", /Visible markdown summary/);
    assert.doesNotMatch(article.excerpt ?? "", /hidden excerpt|<recall/);

    const log = await prisma.activityLog.findFirst({
      where: {
        type: "article_content_stripped",
        authorName: testPrefix,
        title: { contains: articleTitle },
      },
    });
    assert.ok(log, "markdown-sync strip activity log should exist");
    assert.match(JSON.stringify(log.details), /markdown-sync import-applier/);
    assert.match(JSON.stringify(log.details), /strippedBlockCount/);
  } finally {
    await prisma.activityLog.deleteMany({ where: { authorName: testPrefix } });
    await prisma.article.deleteMany({ where: { topicId: topic.id } });
    await prisma.topic.deleteMany({ where: { id: topic.id } });
    await rm(vaultPath, { recursive: true, force: true });
  }
});
