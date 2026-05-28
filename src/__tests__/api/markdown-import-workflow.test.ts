import assert from "node:assert/strict";
import test from "node:test";
import {
  parseMarkdownImportCandidateIds,
  selectMarkdownImportCandidatesById,
} from "@/lib/markdown-sync/import-workflow";
import type { MarkdownImportCandidate } from "@/lib/markdown-sync/import-scanner";

test("parseMarkdownImportCandidateIds accepts arrays and removes blank duplicates", () => {
  assert.deepEqual(
    parseMarkdownImportCandidateIds(["projects/a.md", " ", "projects/a.md", "projects/b.md"]),
    { ok: true, candidateIds: ["projects/a.md", "projects/b.md"] },
  );
});

test("parseMarkdownImportCandidateIds accepts comma-separated strings", () => {
  assert.deepEqual(
    parseMarkdownImportCandidateIds("projects/a.md, projects/b.md,,projects/a.md"),
    { ok: true, candidateIds: ["projects/a.md", "projects/b.md"] },
  );
});

test("parseMarkdownImportCandidateIds rejects malformed candidate IDs", () => {
  assert.deepEqual(parseMarkdownImportCandidateIds(undefined), {
    ok: false,
    error: "candidateIds must be a non-empty string array or comma-separated string.",
  });
  assert.deepEqual(parseMarkdownImportCandidateIds(["projects/a.md", 42]), {
    ok: false,
    error: "candidateIds must contain only strings.",
  });
  assert.deepEqual(parseMarkdownImportCandidateIds(["", "  "]), {
    ok: false,
    error: "candidateIds must include at least one non-empty candidate ID.",
  });
});

test("selectMarkdownImportCandidatesById preserves requested order and reports misses", () => {
  const candidates = [
    candidate("projects/a.md"),
    candidate("projects/b.md"),
    candidate("projects/c.md"),
  ];

  const result = selectMarkdownImportCandidatesById(candidates, [
    "projects/c.md",
    "projects/missing.md",
    "projects/a.md",
  ]);

  assert.deepEqual(result.candidates.map((item) => item.relativePath), ["projects/c.md", "projects/a.md"]);
  assert.deepEqual(result.notFound, ["projects/missing.md"]);
});

function candidate(relativePath: string): MarkdownImportCandidate {
  return {
    kind: "modified",
    relativePath,
    articleId: null,
    manifestPath: relativePath,
    baselineHash: "old",
    markdownHash: "new",
    sizeBytes: 12,
    metadata: null,
    parseError: null,
  };
}
