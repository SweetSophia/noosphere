import type { MarkdownImportCandidate } from "@/lib/markdown-sync/import-scanner";

export type CandidateIdParseResult =
  | { ok: true; candidateIds: string[] }
  | { ok: false; error: string };

export interface CandidateSelectionResult {
  candidates: MarkdownImportCandidate[];
  notFound: string[];
}

/**
 * Normalize candidate IDs passed by agents.
 *
 * Candidate IDs are vault-relative Markdown paths from the import scan result.
 * Accepting either a JSON array or a comma-separated string keeps the API easy
 * to call from shell-based agents while preserving strict non-empty strings.
 */
export function parseMarkdownImportCandidateIds(input: unknown): CandidateIdParseResult {
  const rawIds = typeof input === "string"
    ? input.split(",")
    : Array.isArray(input)
      ? input
      : null;

  if (!rawIds) {
    return { ok: false, error: "candidateIds must be a non-empty string array or comma-separated string." };
  }

  const candidateIds: string[] = [];
  const seen = new Set<string>();
  for (const rawId of rawIds) {
    if (typeof rawId !== "string") {
      return { ok: false, error: "candidateIds must contain only strings." };
    }

    const candidateId = rawId.trim();
    if (!candidateId || seen.has(candidateId)) continue;

    seen.add(candidateId);
    candidateIds.push(candidateId);
  }

  if (candidateIds.length === 0) {
    return { ok: false, error: "candidateIds must include at least one non-empty candidate ID." };
  }

  return { ok: true, candidateIds };
}

export function selectMarkdownImportCandidatesById(
  candidates: MarkdownImportCandidate[],
  candidateIds: string[],
): CandidateSelectionResult {
  const byRelativePath = new Map(candidates.map((candidate) => [candidate.relativePath, candidate]));
  const selected: MarkdownImportCandidate[] = [];
  const notFound: string[] = [];

  for (const candidateId of candidateIds) {
    const candidate = byRelativePath.get(candidateId);
    if (candidate) {
      selected.push(candidate);
    } else {
      notFound.push(candidateId);
    }
  }

  return { candidates: selected, notFound };
}
