import assert from "node:assert/strict";
import test from "node:test";
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
    relativePath: "projects/noosphere-source.md",
    archivePath: ".noosphere-sync/conflicts/2026-projects---noosphere-source.md",
    noosphereHash: "database-hash",
    markdownContent: markdown,
  });

  assert.equal(input.articleId, "article-1");
  assert.equal(input.direction, "vault-to-noosphere");
  assert.equal(input.status, undefined);
  assert.equal(input.relativePath, "projects/noosphere-source.md");
  assert.equal(input.summary.markdown.title, "Markdown Source");
  assert.equal(input.markdownUpdatedAt?.toISOString(), "2026-05-26T11:00:00.000Z");
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
