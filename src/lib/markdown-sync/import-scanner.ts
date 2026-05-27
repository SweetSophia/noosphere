/**
 * Reverse markdown import scanner.
 *
 * This phase is deliberately read-only: it identifies vault-side markdown that
 * could be imported later, but it never mutates Noosphere records or vault files.
 */

import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join, relative, resolve } from "path";
import {
  parseNoosphereMarkdown,
  readMarkdownString,
  readMarkdownStringArray,
} from "@/lib/markdown/noosphere-markdown";
import type { Manifest, ManifestEntry } from "@/lib/obsidian-sync";

export const MARKDOWN_IMPORT_SCAN_MAX_BODY_BYTES = 32 * 1024;
export const MARKDOWN_IMPORT_SCAN_DEFAULT_MAX_FILES = 5_000;
export const MARKDOWN_IMPORT_SCAN_PERMISSIONS = ["ADMIN"] as const;

export type MarkdownImportCandidateKind =
  | "modified"
  | "missing"
  | "baseline-missing"
  | "untracked";

export interface MarkdownImportScanOptions {
  vaultPath: string;
  manifestPath: string;
  includeUntracked?: boolean;
  maxFiles?: number;
}

export interface MarkdownImportMetadata {
  id: string | null;
  slug: string | null;
  title: string | null;
  topic: string | null;
  topicPath: string[];
  tags: string[];
  restrictedTags: string[];
  updatedAt: string | null;
  noosphere: {
    schemaVersion: number | null;
    contentHash: string | null;
    syncedAt: string | null;
    sourceOfTruth: string | null;
  };
}

export interface MarkdownImportCandidate {
  kind: MarkdownImportCandidateKind;
  relativePath: string;
  articleId: string | null;
  manifestPath: string | null;
  baselineHash: string | null;
  markdownHash: string | null;
  sizeBytes: number | null;
  metadata: MarkdownImportMetadata | null;
  parseError: string | null;
}

export interface MarkdownImportScanStats {
  tracked: number;
  scanned: number;
  unchanged: number;
  modified: number;
  missing: number;
  baselineMissing: number;
  untracked: number;
  parseErrors: number;
  skipped: number;
  durationMs: number;
}

export interface MarkdownImportScanResult {
  success: true;
  vaultPath: string;
  manifest: {
    path: string;
    present: boolean;
    articleCount: number;
  };
  stats: MarkdownImportScanStats;
  candidates: MarkdownImportCandidate[];
  warnings: string[];
}

export type MarkdownImportScanBodyValidationResult =
  | { ok: true }
  | { ok: false; status: 400 | 413; error: string };

interface LoadedMarkdown {
  markdownHash: string;
  sizeBytes: number;
  metadata: MarkdownImportMetadata | null;
  parseError: string | null;
}

export class MarkdownImportScanLimitError extends Error {
  constructor(limit: number) {
    super(`Markdown import scan exceeded ${limit} markdown files.`);
    this.name = "MarkdownImportScanLimitError";
  }
}

export function validateMarkdownImportScanContentLength(
  headerValue: string | null,
  maxBytes = MARKDOWN_IMPORT_SCAN_MAX_BODY_BYTES,
): MarkdownImportScanBodyValidationResult {
  if (headerValue === null) return { ok: true };
  if (!/^\d+$/.test(headerValue)) {
    return { ok: false, status: 400, error: "Invalid content-length header" };
  }

  const length = Number(headerValue);
  if (!Number.isSafeInteger(length)) {
    return { ok: false, status: 400, error: "Invalid content-length header" };
  }

  if (length > maxBytes) {
    return { ok: false, status: 413, error: `Request body too large. Maximum size is ${maxBytes} bytes.` };
  }

  return { ok: true };
}

export function validateMarkdownImportScanBodyText(
  bodyText: string,
  maxBytes = MARKDOWN_IMPORT_SCAN_MAX_BODY_BYTES,
): MarkdownImportScanBodyValidationResult {
  if (Buffer.byteLength(bodyText, "utf-8") > maxBytes) {
    return { ok: false, status: 413, error: `Request body too large. Maximum size is ${maxBytes} bytes.` };
  }

  return { ok: true };
}

export function validateMarkdownImportScanRequestBody(body: unknown): {
  includeUntracked: boolean;
  maxFiles: number;
} | { errors: string[] } {
  if (!isPlainObject(body)) {
    return { errors: ["Body must be a JSON object"] };
  }

  const errors: string[] = [];
  const allowed = new Set(["includeUntracked", "maxFiles"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) errors.push(`Unsupported field: ${key}`);
  }

  const includeUntrackedRaw = body["includeUntracked"];
  const includeUntracked = includeUntrackedRaw === undefined ? true : includeUntrackedRaw;
  if (typeof includeUntracked !== "boolean") {
    errors.push("includeUntracked must be a boolean");
  }

  const maxFilesRaw = body["maxFiles"];
  const maxFiles = maxFilesRaw === undefined ? MARKDOWN_IMPORT_SCAN_DEFAULT_MAX_FILES : maxFilesRaw;
  if (!Number.isSafeInteger(maxFiles) || (maxFiles as number) < 1 || (maxFiles as number) > 50_000) {
    errors.push("maxFiles must be an integer between 1 and 50000");
  }

  if (errors.length > 0) return { errors };

  return {
    includeUntracked: includeUntracked as boolean,
    maxFiles: maxFiles as number,
  };
}

export function scanMarkdownImportCandidates(options: MarkdownImportScanOptions): MarkdownImportScanResult {
  const startedAt = Date.now();
  const includeUntracked = options.includeUntracked ?? true;
  const maxFiles = options.maxFiles ?? MARKDOWN_IMPORT_SCAN_DEFAULT_MAX_FILES;
  const warnings: string[] = [];
  const candidates: MarkdownImportCandidate[] = [];
  const manifest = readManifest(options.vaultPath, options.manifestPath, warnings);
  const trackedEntries = manifest ? Object.entries(manifest.articles) : [];
  const trackedPaths = new Set<string>();
  const stats: MarkdownImportScanStats = {
    tracked: trackedEntries.length,
    scanned: 0,
    unchanged: 0,
    modified: 0,
    missing: 0,
    baselineMissing: 0,
    untracked: 0,
    parseErrors: 0,
    skipped: 0,
    durationMs: 0,
  };

  if (trackedEntries.length > maxFiles) {
    throw new MarkdownImportScanLimitError(maxFiles);
  }

  for (const [articleId, entry] of trackedEntries) {
    trackedPaths.add(normalizeRelativePath(entry.path));
    const candidate = scanTrackedEntry(options.vaultPath, articleId, entry, warnings);
    if (!candidate) {
      stats.unchanged++;
      continue;
    }

    candidates.push(candidate);
    incrementCandidateStats(stats, candidate);
  }

  if (includeUntracked) {
    const markdownPaths = listMarkdownFiles(options.vaultPath, maxFiles, warnings);
    for (const relativePath of markdownPaths) {
      if (trackedPaths.has(relativePath)) continue;
      const absolutePath = resolveVaultPath(options.vaultPath, relativePath);
      if (!absolutePath) {
        warnings.push(`Path traversal rejected during scan: ${relativePath}`);
        stats.skipped++;
        continue;
      }

      let loaded: LoadedMarkdown;
      try {
        loaded = loadMarkdownFile(absolutePath);
      } catch (error) {
        warnings.push(`Failed to read untracked file ${relativePath}: ${errorMessage(error)}`);
        stats.skipped++;
        continue;
      }

      const candidate: MarkdownImportCandidate = {
        kind: "untracked",
        relativePath,
        articleId: loaded.metadata?.id ?? null,
        manifestPath: null,
        baselineHash: null,
        markdownHash: loaded.markdownHash,
        sizeBytes: loaded.sizeBytes,
        metadata: loaded.metadata,
        parseError: loaded.parseError,
      };
      candidates.push(candidate);
      incrementCandidateStats(stats, candidate);
    }
  }

  stats.scanned = candidates.length + stats.unchanged;
  stats.durationMs = Date.now() - startedAt;

  return {
    success: true,
    vaultPath: options.vaultPath,
    manifest: {
      path: options.manifestPath,
      present: manifest !== null,
      articleCount: trackedEntries.length,
    },
    stats,
    candidates,
    warnings,
  };
}

function scanTrackedEntry(
  vaultPath: string,
  articleId: string,
  entry: ManifestEntry,
  warnings: string[],
): MarkdownImportCandidate | null {
  const relativePath = normalizeRelativePath(entry.path);
  const absolutePath = resolveVaultPath(vaultPath, relativePath);
  if (!absolutePath) {
    warnings.push(`Path traversal rejected during scan: ${relativePath}`);
    return {
      kind: "missing",
      relativePath,
      articleId,
      manifestPath: relativePath,
      baselineHash: entry.writtenHash ?? entry.contentHash ?? null,
      markdownHash: null,
      sizeBytes: null,
      metadata: null,
      parseError: "Manifest path escapes vault root",
    };
  }

  const baselineHash = entry.writtenHash ?? null;
  if (!existsSync(absolutePath)) {
    return {
      kind: "missing",
      relativePath,
      articleId,
      manifestPath: relativePath,
      baselineHash,
      markdownHash: null,
      sizeBytes: null,
      metadata: null,
      parseError: null,
    };
  }

  let loaded: LoadedMarkdown;
  try {
    loaded = loadMarkdownFile(absolutePath);
  } catch (error) {
    return {
      kind: baselineHash ? "modified" : "baseline-missing",
      relativePath,
      articleId,
      manifestPath: relativePath,
      baselineHash,
      markdownHash: null,
      sizeBytes: null,
      metadata: null,
      parseError: `Failed to read file: ${errorMessage(error)}`,
    };
  }

  if (!baselineHash) {
    return {
      kind: "baseline-missing",
      relativePath,
      articleId,
      manifestPath: relativePath,
      baselineHash: null,
      markdownHash: loaded.markdownHash,
      sizeBytes: loaded.sizeBytes,
      metadata: loaded.metadata,
      parseError: loaded.parseError,
    };
  }

  if (loaded.markdownHash === baselineHash) return null;

  return {
    kind: "modified",
    relativePath,
    articleId,
    manifestPath: relativePath,
    baselineHash,
    markdownHash: loaded.markdownHash,
    sizeBytes: loaded.sizeBytes,
    metadata: loaded.metadata,
    parseError: loaded.parseError,
  };
}

function readManifest(vaultPath: string, manifestPath: string, warnings: string[]): Manifest | null {
  const absolutePath = resolveVaultPath(vaultPath, manifestPath);
  if (!absolutePath) {
    warnings.push(`Manifest path escapes vault root: ${manifestPath}`);
    return null;
  }

  if (!existsSync(absolutePath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(absolutePath, "utf-8")) as Manifest;
    if (parsed.version !== 1 || !parsed.articles || typeof parsed.articles !== "object") {
      warnings.push(`Unsupported manifest format: ${manifestPath}`);
      return null;
    }
    return parsed;
  } catch {
    warnings.push(`Failed to read manifest: ${manifestPath}`);
    return null;
  }
}

function loadMarkdownFile(absolutePath: string): LoadedMarkdown {
  const content = readFileSync(absolutePath, "utf-8");
  const parsed = parseNoosphereMarkdown(content);
  const markdownHash = hashMarkdownContent(content);
  const sizeBytes = Buffer.byteLength(content, "utf-8");

  if (!parsed.ok) {
    return {
      markdownHash,
      sizeBytes,
      metadata: null,
      parseError: parsed.error,
    };
  }

  return {
    markdownHash,
    sizeBytes,
    metadata: extractMetadata(parsed.markdown.frontmatter),
    parseError: null,
  };
}

function extractMetadata(frontmatter: Record<string, unknown>): MarkdownImportMetadata {
  const noosphere = readNoosphereObject(frontmatter);
  return {
    id: readMarkdownString(frontmatter, "id") ?? null,
    slug: readMarkdownString(frontmatter, "slug") ?? null,
    title: readMarkdownString(frontmatter, "title") ?? null,
    topic: readMarkdownString(frontmatter, "topic") ?? null,
    topicPath: readMarkdownStringArray(frontmatter, "topicPath"),
    tags: readMarkdownStringArray(frontmatter, "tags"),
    restrictedTags: readMarkdownStringArray(frontmatter, "restrictedTags"),
    updatedAt: readMarkdownString(frontmatter, "updatedAt") ?? null,
    noosphere: {
      schemaVersion: typeof noosphere["schemaVersion"] === "number" ? noosphere["schemaVersion"] : null,
      contentHash: readNestedString(noosphere, "contentHash"),
      syncedAt: readNestedString(noosphere, "syncedAt"),
      sourceOfTruth: readNestedString(noosphere, "sourceOfTruth"),
    },
  };
}

function listMarkdownFiles(vaultPath: string, maxFiles: number, warnings: string[]): string[] {
  if (!existsSync(vaultPath)) return [];

  const root = resolve(vaultPath);
  const files: string[] = [];
  walk(root);
  return files.sort();

  function walk(directory: string) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      warnings.push(`Failed to read directory ${directory}: ${errorMessage(error)}`);
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = normalizeRelativePath(relative(root, absolutePath));

      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === ".noosphere-sync" || entry.name === "node_modules") {
          continue;
        }
        walk(absolutePath);
        continue;
      }

      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;

      files.push(relativePath);
      if (files.length > maxFiles) {
        throw new MarkdownImportScanLimitError(maxFiles);
      }
    }
  }
}

function incrementCandidateStats(stats: MarkdownImportScanStats, candidate: MarkdownImportCandidate) {
  if (candidate.kind === "modified") stats.modified++;
  else if (candidate.kind === "missing") stats.missing++;
  else if (candidate.kind === "baseline-missing") stats.baselineMissing++;
  else if (candidate.kind === "untracked") stats.untracked++;

  if (candidate.parseError) stats.parseErrors++;
}

function resolveVaultPath(vaultPath: string, relativePath: string): string | null {
  const root = resolve(vaultPath).replace(/[/\\]+$/, "").replace(/\\/g, "/");
  const absolutePath = resolve(vaultPath, relativePath).replace(/\\/g, "/");
  if (!absolutePath.startsWith(`${root}/`)) return null;
  return absolutePath;
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function hashMarkdownContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function readNoosphereObject(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const value = frontmatter["noosphere"];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readNestedString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
