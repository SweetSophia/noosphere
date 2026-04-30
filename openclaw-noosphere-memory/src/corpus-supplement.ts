import { formatError } from "./format.js";
import type { NoosphereMemoryResult } from "./types.js";
import type { NoosphereClientContext } from "./shared-init.js";

export interface CorpusSupplementLogger {
  warn?: (message: string) => void;
}

export interface MemoryCorpusSearchResult {
  corpus: string;
  path: string;
  title?: string;
  kind?: string;
  score: number;
  snippet: string;
  id?: string;
  citation?: string;
  source?: string;
  provenanceLabel?: string;
  sourceType?: string;
  sourcePath?: string;
  updatedAt?: string;
}

export interface MemoryCorpusGetResult {
  corpus: string;
  path: string;
  title?: string;
  kind?: string;
  content: string;
  fromLine: number;
  lineCount: number;
  id?: string;
  provenanceLabel?: string;
  sourceType?: string;
  sourcePath?: string;
  updatedAt?: string;
}

export interface MemoryCorpusSupplement {
  search(params: {
    query: string;
    maxResults?: number;
    agentSessionKey?: string;
  }): Promise<MemoryCorpusSearchResult[]>;
  get(params: {
    lookup: string;
    fromLine?: number;
    lineCount?: number;
    agentSessionKey?: string;
  }): Promise<MemoryCorpusGetResult | null>;
}

const CORPUS_ID = "noosphere";
const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS = 10;
const DEFAULT_LINE_COUNT = 200;

export function createNoosphereCorpusSupplement(
  context: NoosphereClientContext,
  logger?: CorpusSupplementLogger,
): MemoryCorpusSupplement {
  return {
    async search(input) {
      const query = input.query.trim();
      if (!query) return [];

      try {
        const response = await context.client.recall({
          query,
          mode: "inspection",
          resultCap: clampMaxResults(input.maxResults),
          providers: ["noosphere"],
        });

        return response.results
          .filter(isNoosphereMemoryResult)
          .map(toCorpusSearchResult);
      } catch (error) {
        warnAndFailOpen(logger, "search", error, context);
        return [];
      }
    },

    async get(input) {
      const lookup = input.lookup.trim();
      if (!lookup) return null;

      try {
        const response = await context.client.get(toNoosphereGetRequest(lookup));
        if (!response.result) return null;
        return toCorpusGetResult(response.result, input.fromLine, input.lineCount);
      } catch (error) {
        warnAndFailOpen(logger, "get", error, context);
        return null;
      }
    },
  };
}

function toCorpusSearchResult(
  result: NoosphereMemoryResult,
): MemoryCorpusSearchResult {
  const path = toCorpusPath(result);
  return {
    corpus: CORPUS_ID,
    path,
    title: result.title,
    kind: result.sourceType,
    score: normalizeScore(result.relevanceScore),
    snippet: toSnippet(result),
    id: result.canonicalRef ?? result.id,
    citation: result.canonicalRef ?? path,
    source: result.provider,
    provenanceLabel: "Noosphere",
    sourceType: result.sourceType,
    sourcePath: path,
    updatedAt: result.updatedAt ?? result.createdAt,
  };
}

function toCorpusGetResult(
  result: NoosphereMemoryResult,
  fromLine: number | undefined,
  lineCount: number | undefined,
): MemoryCorpusGetResult {
  const lines = result.content.split(/\r?\n/);
  const startLine = normalizePositiveInteger(fromLine, 1);
  const count = normalizePositiveInteger(lineCount, DEFAULT_LINE_COUNT);
  const selectedLines = lines.slice(startLine - 1, startLine - 1 + count);
  const path = toCorpusPath(result);

  return {
    corpus: CORPUS_ID,
    path,
    title: result.title,
    kind: result.sourceType,
    content: selectedLines.join("\n"),
    fromLine: startLine,
    lineCount: selectedLines.length,
    id: result.canonicalRef ?? result.id,
    provenanceLabel: "Noosphere",
    sourceType: result.sourceType,
    sourcePath: path,
    updatedAt: result.updatedAt ?? result.createdAt,
  };
}

function toNoosphereGetRequest(lookup: string) {
  if (lookup.includes(":")) return { canonicalRef: lookup } as const;
  return { provider: "noosphere", id: lookup } as const;
}

function toCorpusPath(result: NoosphereMemoryResult): string {
  const ref = result.canonicalRef ?? `${result.provider}:${result.sourceType}:${result.id}`;
  return ref.replace(/[^a-zA-Z0-9._:-]+/g, "-");
}

function toSnippet(result: NoosphereMemoryResult): string {
  const source = result.summary?.trim() || result.content.trim();
  const collapsed = source.replace(/\s+/g, " ").trim();
  return collapsed.length > 240 ? `${collapsed.slice(0, 237)}...` : collapsed;
}

function normalizeScore(score: number | undefined): number {
  if (typeof score !== "number" || !Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1, score));
}

function clampMaxResults(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_RESULTS;
  return Math.max(1, Math.min(MAX_RESULTS, Math.floor(value)));
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

function isNoosphereMemoryResult(value: unknown): value is NoosphereMemoryResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NoosphereMemoryResult>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.provider === "string" &&
    typeof candidate.sourceType === "string" &&
    typeof candidate.content === "string"
  );
}

function warnAndFailOpen(
  logger: CorpusSupplementLogger | undefined,
  operation: "search" | "get",
  error: unknown,
  context: NoosphereClientContext,
): void {
  const formatted = formatError(error, context.config);
  logger?.warn?.(
    `Noosphere corpus supplement ${operation} skipped: ${String(formatted.error)}`,
  );
}
