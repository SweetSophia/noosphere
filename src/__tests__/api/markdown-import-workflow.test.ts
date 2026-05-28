import assert from "node:assert/strict";
import test from "node:test";
import {
  parseMarkdownImportCandidateIds,
  selectMarkdownImportCandidatesById,
  selectMarkdownImportCandidatesByQueryIds,
  validateMarkdownImportCandidates,
} from "@/lib/markdown-sync/import-workflow";
import type { MarkdownImportCandidate } from "@/lib/markdown-sync/import-scanner";

test("parseMarkdownImportCandidateIds accepts arrays and removes blank duplicates", () => {
  assert.deepEqual(
    parseMarkdownImportCandidateIds(["projects/a.md", " ", "projects/a.md", "projects/b.md"]),
    { ok: true, candidateIds: ["projects/a.md", "projects/b.md"] },
  );
});

test("parseMarkdownImportCandidateIds preserves commas in array values", () => {
  assert.deepEqual(
    parseMarkdownImportCandidateIds(["notes/a, b.md", "projects/c.md"]),
    { ok: true, candidateIds: ["notes/a, b.md", "projects/c.md"] },
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
    error: "candidateIds must be a non-empty string array or comma-separated string; received undefined.",
  });
  assert.deepEqual(parseMarkdownImportCandidateIds(42), {
    ok: false,
    error: "candidateIds must be a non-empty string array or comma-separated string; received number.",
  });
  assert.deepEqual(parseMarkdownImportCandidateIds({}), {
    ok: false,
    error: "candidateIds must be a non-empty string array or comma-separated string; received object.",
  });
  assert.deepEqual(parseMarkdownImportCandidateIds(["projects/a.md", 42]), {
    ok: false,
    error: "candidateIds[1] must be a string; received number.",
  });
  assert.deepEqual(parseMarkdownImportCandidateIds(["", "  "]), {
    ok: false,
    error: "candidateIds must include at least one non-empty candidate ID.",
  });
});

test("validateMarkdownImportCandidates rejects malformed legacy candidates", () => {
  assert.deepEqual(validateMarkdownImportCandidates([]), {
    ok: false,
    error: "candidates must be a non-empty array.",
  });
  assert.deepEqual(validateMarkdownImportCandidates([42]), {
    ok: false,
    error: "candidates[0] must be an object.",
  });
  assert.deepEqual(validateMarkdownImportCandidates([{ kind: "modified" }]), {
    ok: false,
    error: "candidates[0].relativePath must be a non-empty string.",
  });
  assert.deepEqual(validateMarkdownImportCandidates([{ relativePath: "projects/a.md", kind: "invalid" }]), {
    ok: false,
    error: 'candidates[0].kind must be one of modified, missing, baseline-missing, untracked; received "invalid".',
  });
  assert.deepEqual(validateMarkdownImportCandidates([{ ...candidate("projects/a.md"), articleId: 42 }]), {
    ok: false,
    error: "candidates[0].articleId must be a string or null.",
  });
  assert.deepEqual(validateMarkdownImportCandidates([{ ...candidate("projects/a.md"), sizeBytes: -1 }]), {
    ok: false,
    error: "candidates[0].sizeBytes must be a non-negative integer or null.",
  });
  assert.deepEqual(validateMarkdownImportCandidates([{ ...candidate("projects/a.md"), metadata: [] }]), {
    ok: false,
    error: "candidates[0].metadata must be an object or null.",
  });
});

test("validateMarkdownImportCandidates accepts minimal legacy candidates", () => {
  const candidates = [candidate("projects/a.md")];
  assert.deepEqual(validateMarkdownImportCandidates(candidates), {
    ok: true,
    candidates,
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

test("selectMarkdownImportCandidatesByQueryIds preserves single comma-bearing paths", () => {
  const candidates = [
    candidate("notes/a, b.md"),
    candidate("notes/c.md"),
  ];

  const result = selectMarkdownImportCandidatesByQueryIds(candidates, ["notes/a, b.md"]);

  assert.deepEqual(result.candidateIds, ["notes/a, b.md"]);
  assert.deepEqual(result.candidates.map((item) => item.relativePath), ["notes/a, b.md"]);
  assert.deepEqual(result.notFound, []);
});

test("selectMarkdownImportCandidatesByQueryIds falls back to legacy comma lists", () => {
  const candidates = [
    candidate("projects/a.md"),
    candidate("projects/b.md"),
  ];

  const result = selectMarkdownImportCandidatesByQueryIds(candidates, ["projects/a.md, projects/b.md"]);

  assert.deepEqual(result.candidateIds, ["projects/a.md", "projects/b.md"]);
  assert.deepEqual(result.candidates.map((item) => item.relativePath), ["projects/a.md", "projects/b.md"]);
  assert.deepEqual(result.notFound, []);
});

test("selectMarkdownImportCandidatesByQueryIds does not split non-existent comma-bearing paths", () => {
  const candidates = [candidate("notes/c.md")];

  const result = selectMarkdownImportCandidatesByQueryIds(candidates, ["notes/a, b.md"]);

  assert.deepEqual(result.candidateIds, ["notes/a, b.md"]);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.notFound, ["notes/a, b.md"]);
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
