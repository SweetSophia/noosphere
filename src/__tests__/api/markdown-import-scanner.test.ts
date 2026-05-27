import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  MARKDOWN_IMPORT_SCAN_PERMISSIONS,
  MarkdownImportScanLimitError,
  scanMarkdownImportCandidates,
  validateMarkdownImportScanBodyText,
  validateMarkdownImportScanContentLength,
  validateMarkdownImportScanRequestBody,
} from "@/lib/markdown-sync/import-scanner";

const manifestPath = ".noosphere-sync/manifest.json";

test("markdown import scan API policy is admin-only", () => {
  assert.deepEqual(MARKDOWN_IMPORT_SCAN_PERMISSIONS, ["ADMIN"]);
});

test("scanMarkdownImportCandidates reports modified managed markdown with parsed metadata", () => {
  withVault((vaultPath) => {
    const relativePath = "projects/noosphere-source.md";
    const previous = markdown({ id: "article-1", title: "Previous", slug: "noosphere-source" }, "Old body");
    const current = markdown({ id: "article-1", title: "Edited", slug: "noosphere-source" }, "Edited body");
    writeFileSync(join(vaultPath, relativePath), current, "utf-8");
    writeManifest(vaultPath, {
      "article-1": {
        path: relativePath,
        updatedAt: "2026-05-27T10:00:00.000Z",
        contentHash: "canonical-db-hash",
        writtenHash: sha256(previous),
        deletedAt: null,
      },
    });

    const result = scanMarkdownImportCandidates({
      vaultPath,
      manifestPath,
      includeUntracked: false,
    });

    assert.equal(result.manifest.present, true);
    assert.equal(result.stats.tracked, 1);
    assert.equal(result.stats.modified, 1);
    assert.equal(result.stats.unchanged, 0);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].kind, "modified");
    assert.equal(result.candidates[0].articleId, "article-1");
    assert.equal(result.candidates[0].metadata?.title, "Edited");
    assert.equal(result.candidates[0].metadata?.noosphere.schemaVersion, 1);
  });
});

test("scanMarkdownImportCandidates omits unchanged managed markdown", () => {
  withVault((vaultPath) => {
    const relativePath = "projects/noosphere-source.md";
    const content = markdown({ id: "article-1", title: "Noosphere Source", slug: "noosphere-source" }, "Body");
    writeFileSync(join(vaultPath, relativePath), content, "utf-8");
    writeManifest(vaultPath, {
      "article-1": {
        path: relativePath,
        updatedAt: "2026-05-27T10:00:00.000Z",
        contentHash: "canonical-db-hash",
        writtenHash: sha256(content),
        deletedAt: null,
      },
    });

    const result = scanMarkdownImportCandidates({
      vaultPath,
      manifestPath,
      includeUntracked: false,
    });

    assert.equal(result.stats.unchanged, 1);
    assert.equal(result.stats.modified, 0);
    assert.equal(result.candidates.length, 0);
  });
});

test("scanMarkdownImportCandidates reports missing and baseline-missing tracked entries", () => {
  withVault((vaultPath) => {
    const baselineMissingPath = "projects/baseline-missing.md";
    const content = markdown({ id: "article-2", title: "Baseline Missing", slug: "baseline-missing" }, "Body");
    writeFileSync(join(vaultPath, baselineMissingPath), content, "utf-8");
    writeManifest(vaultPath, {
      "article-1": {
        path: "projects/missing.md",
        updatedAt: "2026-05-27T10:00:00.000Z",
        contentHash: "canonical-db-hash",
        writtenHash: sha256("missing-old-content"),
        deletedAt: null,
      },
      "article-2": {
        path: baselineMissingPath,
        updatedAt: "2026-05-27T10:00:00.000Z",
        contentHash: "canonical-db-hash",
        deletedAt: null,
      },
    });

    const result = scanMarkdownImportCandidates({
      vaultPath,
      manifestPath,
      includeUntracked: false,
    });

    assert.equal(result.stats.missing, 1);
    assert.equal(result.stats.baselineMissing, 1);
    assert.deepEqual(result.candidates.map((candidate) => candidate.kind).sort(), ["baseline-missing", "missing"]);
  });
});

test("scanMarkdownImportCandidates reports untracked markdown and ignores internal files", () => {
  withVault((vaultPath) => {
    writeFileSync(
      join(vaultPath, "inbox/untracked.md"),
      markdown({ title: "Untracked", slug: "untracked" }, "Body"),
      "utf-8",
    );
    mkdirSync(join(vaultPath, ".noosphere-sync/conflicts"), { recursive: true });
    writeFileSync(join(vaultPath, ".noosphere-sync/conflicts/internal.md"), "# Internal", "utf-8");
    writeManifest(vaultPath, {});

    const result = scanMarkdownImportCandidates({
      vaultPath,
      manifestPath,
      includeUntracked: true,
    });

    assert.equal(result.stats.untracked, 1);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].relativePath, "inbox/untracked.md");
    assert.equal(result.candidates[0].metadata?.title, "Untracked");
  });
});

test("scanMarkdownImportCandidates captures parse errors without aborting scan", () => {
  withVault((vaultPath) => {
    writeFileSync(join(vaultPath, "bad.md"), "# Missing frontmatter", "utf-8");
    writeManifest(vaultPath, {});

    const result = scanMarkdownImportCandidates({
      vaultPath,
      manifestPath,
      includeUntracked: true,
    });

    assert.equal(result.stats.parseErrors, 1);
    assert.equal(result.candidates[0].parseError, "No YAML frontmatter found");
  });
});

test("scanMarkdownImportCandidates enforces maxFiles", () => {
  withVault((vaultPath) => {
    writeFileSync(join(vaultPath, "one.md"), markdown({ title: "One" }, "One"), "utf-8");
    writeFileSync(join(vaultPath, "two.md"), markdown({ title: "Two" }, "Two"), "utf-8");
    writeManifest(vaultPath, {});

    assert.throws(
      () => scanMarkdownImportCandidates({ vaultPath, manifestPath, includeUntracked: true, maxFiles: 1 }),
      MarkdownImportScanLimitError,
    );
  });
});

test("scanMarkdownImportCandidates enforces maxFiles for tracked manifest entries", () => {
  withVault((vaultPath) => {
    writeFileSync(join(vaultPath, "projects/one.md"), markdown({ id: "one", title: "One" }, "One"), "utf-8");
    writeFileSync(join(vaultPath, "projects/two.md"), markdown({ id: "two", title: "Two" }, "Two"), "utf-8");
    writeManifest(vaultPath, {
      one: {
        path: "projects/one.md",
        updatedAt: "2026-05-27T10:00:00.000Z",
        contentHash: "one-db-hash",
        writtenHash: sha256("one-old"),
        deletedAt: null,
      },
      two: {
        path: "projects/two.md",
        updatedAt: "2026-05-27T10:00:00.000Z",
        contentHash: "two-db-hash",
        writtenHash: sha256("two-old"),
        deletedAt: null,
      },
    });

    assert.throws(
      () => scanMarkdownImportCandidates({ vaultPath, manifestPath, includeUntracked: false, maxFiles: 1 }),
      MarkdownImportScanLimitError,
    );
  });
});

test("scanMarkdownImportCandidates does not count tracked paths against untracked walk", () => {
  withVault((vaultPath) => {
    const content = markdown({ id: "one", title: "One" }, "One");
    writeFileSync(join(vaultPath, "projects/one.md"), content, "utf-8");
    writeManifest(vaultPath, {
      one: {
        path: "projects/one.md",
        updatedAt: "2026-05-27T10:00:00.000Z",
        contentHash: "one-db-hash",
        writtenHash: sha256(content),
        deletedAt: null,
      },
    });

    const result = scanMarkdownImportCandidates({
      vaultPath,
      manifestPath,
      includeUntracked: true,
      maxFiles: 1,
    });

    assert.equal(result.stats.unchanged, 1);
    assert.equal(result.candidates.length, 0);
  });
});

test("scanMarkdownImportCandidates rejects malformed manifest article maps", () => {
  withVault((vaultPath) => {
    writeFileSync(
      join(vaultPath, manifestPath),
      JSON.stringify({
        version: 1,
        vaultPath,
        lastRunAt: "2026-05-27T10:00:00.000Z",
        articles: [],
      }),
      "utf-8",
    );

    const result = scanMarkdownImportCandidates({ vaultPath, manifestPath, includeUntracked: false });

    assert.equal(result.manifest.present, false);
    assert.equal(result.warnings.some((warning) => warning.includes("Unsupported manifest format")), true);
  });
});

test("scanMarkdownImportCandidates rejects tracked symlink targets", () => {
  withVault((vaultPath) => {
    symlinkSync("/etc/passwd", join(vaultPath, "projects/link.md"));
    writeManifest(vaultPath, {
      link: {
        path: "projects/link.md",
        updatedAt: "2026-05-27T10:00:00.000Z",
        contentHash: "link-db-hash",
        writtenHash: sha256("old"),
        deletedAt: null,
      },
    });

    const result = scanMarkdownImportCandidates({ vaultPath, manifestPath, includeUntracked: false });

    assert.equal(result.stats.modified, 1);
    assert.equal(result.candidates[0].markdownHash, null);
    assert.match(result.candidates[0].parseError ?? "", /symlink|vault root/);
  });
});

test("markdown import scan request validation rejects malformed input", () => {
  assert.deepEqual(validateMarkdownImportScanContentLength(null, 10), { ok: true });
  assert.deepEqual(validateMarkdownImportScanContentLength(" 10 ", 10), { ok: true });
  assert.deepEqual(validateMarkdownImportScanContentLength("abc", 10), {
    ok: false,
    status: 400,
    error: "Invalid content-length header",
  });
  assert.deepEqual(validateMarkdownImportScanContentLength("11", 10), {
    ok: false,
    status: 413,
    error: "Request body too large. Maximum size is 10 bytes.",
  });
  assert.deepEqual(validateMarkdownImportScanBodyText("12345678901", 10), {
    ok: false,
    status: 413,
    error: "Request body too large. Maximum size is 10 bytes.",
  });
  assert.deepEqual(validateMarkdownImportScanRequestBody([]), { errors: ["Body must be a JSON object"] });
  assert.deepEqual(validateMarkdownImportScanRequestBody({ includeUntracked: "yes" }), {
    errors: ["includeUntracked must be a boolean"],
  });
});

function withVault(run: (vaultPath: string) => void) {
  const vaultPath = `/tmp/noosphere-import-scan-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    mkdirSync(join(vaultPath, "projects"), { recursive: true });
    mkdirSync(join(vaultPath, "inbox"), { recursive: true });
    mkdirSync(join(vaultPath, ".noosphere-sync"), { recursive: true });
    run(vaultPath);
  } finally {
    rmSync(vaultPath, { recursive: true, force: true });
  }
}

function writeManifest(vaultPath: string, articles: Record<string, object>) {
  writeFileSync(
    join(vaultPath, manifestPath),
    JSON.stringify({
      version: 1,
      vaultPath,
      lastRunAt: "2026-05-27T10:00:00.000Z",
      articles,
    }),
    "utf-8",
  );
}

function markdown(frontmatter: Record<string, unknown>, body: string): string {
  const lines = [
    "---",
    `id: ${frontmatter["id"] ?? ""}`,
    `slug: ${frontmatter["slug"] ?? "sample"}`,
    `title: ${frontmatter["title"]}`,
    "topic: projects",
    "topicPath:",
    "  - projects",
    "tags:",
    "  - sync",
    "updatedAt: \"2026-05-27T10:00:00.000Z\"",
    "noosphere:",
    "  entity: article",
    "  schemaVersion: 1",
    "  syncedAt: \"2026-05-27T10:01:00.000Z\"",
    "  sourceOfTruth: database",
    "---",
    "",
    body,
  ];
  return lines.join("\n");
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
