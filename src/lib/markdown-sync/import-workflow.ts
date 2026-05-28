import {
  MARKDOWN_IMPORT_CANDIDATE_KINDS,
  type MarkdownImportCandidate,
} from "@/lib/markdown-sync/import-scanner";

const MARKDOWN_IMPORT_CANDIDATE_KIND_SET = new Set<string>(MARKDOWN_IMPORT_CANDIDATE_KINDS);

export type CandidateIdParseResult =
  | { ok: true; candidateIds: string[] }
  | { ok: false; error: string };

export interface CandidateSelectionResult {
  candidates: MarkdownImportCandidate[];
  notFound: string[];
}

export interface CandidateQuerySelectionResult extends CandidateSelectionResult {
  candidateIds: string[];
}

export type CandidateValidationResult =
  | { ok: true; candidates: MarkdownImportCandidate[] }
  | { ok: false; error: string };

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
    return {
      ok: false,
      error: `candidateIds must be a non-empty string array or comma-separated string; received ${describeInputType(input)}.`,
    };
  }

  const candidateIds: string[] = [];
  const seen = new Set<string>();
  for (const [index, rawId] of rawIds.entries()) {
    if (typeof rawId !== "string") {
      return {
        ok: false,
        error: `candidateIds[${index}] must be a string; received ${describeInputType(rawId)}.`,
      };
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

export function validateMarkdownImportCandidates(input: unknown): CandidateValidationResult {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, error: "candidates must be a non-empty array." };
  }

  for (const [index, candidate] of input.entries()) {
    if (!isPlainObject(candidate)) {
      return { ok: false, error: `candidates[${index}] must be an object.` };
    }
    if (typeof candidate["relativePath"] !== "string" || candidate["relativePath"].trim() === "") {
      return { ok: false, error: `candidates[${index}].relativePath must be a non-empty string.` };
    }
    if (typeof candidate["kind"] !== "string" || !MARKDOWN_IMPORT_CANDIDATE_KIND_SET.has(candidate["kind"])) {
      return {
        ok: false,
        error:
          `candidates[${index}].kind must be one of ${MARKDOWN_IMPORT_CANDIDATE_KINDS.join(", ")}; ` +
          `received ${describeInvalidValue(candidate["kind"])}.`,
      };
    }
    const nullableStringFields = ["articleId", "manifestPath", "baselineHash", "markdownHash", "parseError"];
    for (const field of nullableStringFields) {
      const value = candidate[field];
      if (value !== undefined && value !== null && typeof value !== "string") {
        return { ok: false, error: `candidates[${index}].${field} must be a string or null.` };
      }
    }
    const sizeBytes = candidate["sizeBytes"];
    if (sizeBytes !== undefined && sizeBytes !== null) {
      if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
        return { ok: false, error: `candidates[${index}].sizeBytes must be a non-negative integer or null.` };
      }
    }
    if (candidate["metadata"] !== undefined && candidate["metadata"] !== null && !isPlainObject(candidate["metadata"])) {
      return { ok: false, error: `candidates[${index}].metadata must be an object or null.` };
    }
  }

  return { ok: true, candidates: input as MarkdownImportCandidate[] };
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

export function selectMarkdownImportCandidatesByQueryIds(
  candidates: MarkdownImportCandidate[],
  candidateIdsParams: string[],
): CandidateQuerySelectionResult {
  const exactCandidateIds = parseMarkdownImportCandidateIds(candidateIdsParams);
  if (!exactCandidateIds.ok) {
    return { candidates: [], notFound: candidateIdsParams, candidateIds: [] };
  }

  const exactSelection = selectMarkdownImportCandidatesById(candidates, exactCandidateIds.candidateIds);
  if (
    exactSelection.candidates.length > 0 ||
    candidateIdsParams.length !== 1 ||
    !candidateIdsParams[0].includes(",")
  ) {
    return { ...exactSelection, candidateIds: exactCandidateIds.candidateIds };
  }

  const legacyCandidateIds = parseMarkdownImportCandidateIds(candidateIdsParams[0]);
  if (!legacyCandidateIds.ok) {
    return { ...exactSelection, candidateIds: exactCandidateIds.candidateIds };
  }

  const legacySelection = selectMarkdownImportCandidatesById(candidates, legacyCandidateIds.candidateIds);
  if (legacySelection.candidates.length > 0) {
    return { ...legacySelection, candidateIds: legacyCandidateIds.candidateIds };
  }
  return { ...exactSelection, candidateIds: exactCandidateIds.candidateIds };
}

function describeInputType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeInvalidValue(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : describeInputType(value);
}
