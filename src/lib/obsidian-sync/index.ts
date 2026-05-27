/**
 * Obsidian Shadow Sync — Core Sync Engine
 *
 * One-way sync of Noosphere articles to an Obsidian-compatible markdown vault.
 * Database is always the source of truth.
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve, relative as pathRelative } from "path";
import { spawn } from "child_process";
import type { ObsidianSyncConfig } from "./config";
import { getObsidianSyncConfig } from "./config";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import {
  computeNoosphereContentHash,
  renderNoosphereMarkdown,
  type NoosphereMarkdownArticle,
} from "@/lib/markdown/noosphere-markdown";
import { buildSyncConflictReviewCreateInput } from "@/lib/markdown-sync/conflict-review";
import { recordSyncConflictReview } from "@/lib/markdown-sync/api/conflict-review";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface SyncOptions {
  mode: "incremental" | "full";
  articleIds?: string[];
  topicIds?: string[];
  clean: boolean;
  git: boolean;
  dryRun: boolean;
  callerName?: string;
}

export interface ManifestEntry {
  path: string;
  updatedAt: string; // ISO string
  contentHash: string;
  /** SHA-256 hash of the exact bytes last written to disk (includes real syncedAt).
   *  Used for conflict detection. Undefined for legacy manifests created before
   *  this field existed, or on first sync when the file hasn't been written yet. */
  writtenHash?: string;
  deletedAt: string | null;
}

export interface Manifest {
  version: number;
  vaultPath: string;
  lastRunAt: string;
  articles: Record<string, ManifestEntry>;
}

export interface SyncStats {
  scanned: number;
  written: number;
  updated: number;
  created: number;
  unchanged: number;
  deleted: number;
  skipped: number;
  conflictsDetected: number;
  durationMs: number;
  [key: string]: number;
}

export interface GitResult {
  enabled: boolean;
  attempted: boolean;
  committed: boolean;
  commitHash: string | null;
  branch: string | null;
  error?: string;
  [key: string]: unknown;
}

export interface SyncResult {
  success: boolean;
  mode: string;
  dryRun: boolean;
  vaultPath: string;
  git: GitResult;
  stats: SyncStats;
  manifest: { updated: boolean; path: string };
  warnings: string[];
}

// ─────────────────────────────────────────────
// Lock — PostgreSQL advisory lock
// ─────────────────────────────────────────────

const LOCK_ID = 9847291; // arbitrary unique integer for this feature

async function acquireLock(): Promise<boolean> {
  try {
    const result = await prisma.$queryRaw<{ acquire: boolean }[]>`
      SELECT pg_try_advisory_lock(${LOCK_ID}) AS acquire
    `;
    return result[0]?.acquire === true;
  } catch {
    // If advisory lock is unavailable (e.g., Prisma/PG error), deny the lock
    // rather than using a broken in-process fallback that would allow concurrent
    // syncs to race.
    return false;
  }
}

async function releaseLock(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT pg_advisory_unlock(${LOCK_ID})`;
  } catch {
    // best-effort; lock auto-expires on DB session end
  }
}

// ─────────────────────────────────────────────
// Git helpers
// ─────────────────────────────────────────────

async function isGitRepo(dir: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.on("close", (code) => resolve(code === 0 && out.trim() === "true"));
    proc.on("error", () => resolve(false));
  });
}

async function getCurrentBranch(dir: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["branch", "--show-current"], { cwd: dir });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.on("close", (code) => resolve(code === 0 ? out.trim() : null));
    proc.on("error", () => resolve(null));
  });
}

async function gitStatusPorcelain(dir: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["status", "--porcelain"], { cwd: dir });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.on("close", () => resolve(out));
    proc.on("error", () => resolve(""));
  });
}

function normalizeManagedGitPaths(vaultPath: string, managedPaths: string[]): string[] {
  const safePaths = new Set<string>();

  for (const managedPath of managedPaths) {
    const safeAbsolutePath = safePath(vaultPath, managedPath);
    if (!safeAbsolutePath) continue;

    const relativePath = pathRelative(vaultPath, safeAbsolutePath).replace(/\\/g, "/");
    if (!relativePath || relativePath === "." || relativePath === ".." || relativePath.startsWith("../")) {
      continue;
    }
    if (relativePath === ".git" || relativePath.startsWith(".git/")) {
      continue;
    }

    safePaths.add(relativePath);
  }

  return [...safePaths];
}

async function gitAddManaged(dir: string, managedPaths: string[]): Promise<void> {
  const safeManagedPaths = normalizeManagedGitPaths(dir, managedPaths);
  // Always stage .noosphere-sync/ (manifest, conflicts) even when no article paths changed.
  const args = ["add", "--", ...safeManagedPaths, ".noosphere-sync"];
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, { cwd: dir });
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git add exited ${code}`))));
    proc.on("error", reject);
  });
}

async function gitCommit(dir: string, stats: SyncStats, warnings: string[]): Promise<{ hash: string | null; error?: string }> {
  const body = [
    `chore(noosphere): sync obsidian shadow vault ${new Date().toISOString()}`,
    "",
    `Created: ${stats.created}`,
    `Updated: ${stats.updated}`,
    `Deleted: ${stats.deleted}`,
    `Warnings: ${warnings.length}`,
    "",
    ...warnings.slice(0, 5).map((w) => `  - ${w}`),
  ].join("\n");

  return new Promise((resolve) => {
    const proc = spawn(
      "git",
      ["commit", "-m", body, "--author=Noosphere Sync <noosphere@sync.local>"],
      { cwd: dir }
    );
    let err = "";
    proc.stderr.on("data", (d) => (err += d));
    proc.on("close", (code) => {
      if (code === 0) {
        const hashProc = spawn("git", ["rev-parse", "HEAD"], { cwd: dir });
        let hash = "";
        hashProc.stdout.on("data", (d) => (hash += d));
        hashProc.on("close", () => resolve({ hash: hash.trim() }));
      } else {
        resolve({ hash: null, error: err.trim() || `git commit exited ${code}` });
      }
    });
    proc.on("error", (e) => resolve({ hash: null, error: e.message }));
  });
}

// ─────────────────────────────────────────────
// Topic path resolution
// ─────────────────────────────────────────────

interface TopicNode {
  id: string;
  slug: string;
  parentId: string | null;
  name: string;
}

function buildTopicPath(topicMap: Map<string, TopicNode>, topicId: string): string[] {
  const path: string[] = [];
  let current = topicMap.get(topicId);
  while (current) {
    path.unshift(current.slug);
    current = current.parentId ? topicMap.get(current.parentId) : undefined;
  }
  return path;
}

function buildArticlePath(topicPath: string[], articleSlug: string): string {
  return [...topicPath, `${articleSlug}.md`].join("/");
}

// ─────────────────────────────────────────────
// Frontmatter & content rendering
// ─────────────────────────────────────────────

interface ArticleForSync {
  id: string;
  slug: string;
  title: string;
  content: string;
  excerpt: string | null;
  confidence: string | null;
  status: string;
  sourceUrl: string | null;
  sourceType: string | null;
  lastReviewed: Date | null;
  createdAt: Date;
  updatedAt: Date;
  restrictedTags: string[];
  authorName: string | null;
  topicId: string;
  tags: Array<{ tag: { name: string; slug: string } }>;
  topic: { id: string; slug: string; name: string };
}

function toMarkdownArticle(article: ArticleForSync, topicPath: string[]): NoosphereMarkdownArticle {
  return {
    id: article.id,
    slug: article.slug,
    title: article.title,
    topic: article.topic.slug,
    topicPath,
    content: article.content,
    confidence: article.confidence,
    status: article.status,
    tags: article.tags.map((t) => t.tag.slug),
    restrictedTags: article.restrictedTags,
    excerpt: article.excerpt,
    authorName: article.authorName,
    sourceUrl: article.sourceUrl,
    sourceType: article.sourceType,
    lastReviewed: article.lastReviewed,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
  };
}

function renderMarkdown(article: ArticleForSync, topicPath: string[], contentHash: string, syncedAt: string, publish: boolean): string {
  return renderNoosphereMarkdown(toMarkdownArticle(article, topicPath), {
    contentHash,
    syncedAt,
    publish,
  });
}

/**
 * Compute a stable SHA-256 hash of the article content for change detection.
 * Uses a fixed placeholder for syncedAt so the hash is deterministic
 * regardless of when the sync runs.
 */
function computeContentHash(article: ArticleForSync, topicPath: string[]): string {
  return computeNoosphereContentHash(toMarkdownArticle(article, topicPath));
}

// ─────────────────────────────────────────────
// Manifest handling
// ─────────────────────────────────────────────

function readManifest(vaultPath: string, config: ObsidianSyncConfig): Manifest | null {
  const manifestFile = join(vaultPath, config.manifestPath);
  if (!existsSync(manifestFile)) return null;
  try {
    const raw = readFileSync(manifestFile, "utf-8");
    const m = JSON.parse(raw) as Manifest;
    if (m.version !== 1) return null;
    return m;
  } catch {
    return null;
  }
}

function writeManifest(vaultPath: string, config: ObsidianSyncConfig, manifest: Manifest): void {
  const dir = join(vaultPath, ".noosphere-sync");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const manifestFile = join(vaultPath, config.manifestPath);
  const tmp = `${manifestFile}.tmp.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf-8");
  renameSync(tmp, manifestFile);
}

function writeLastRun(vaultPath: string, config: ObsidianSyncConfig, result: SyncResult): void {
  const dir = join(vaultPath, ".noosphere-sync");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const lastRunFile = join(vaultPath, config.lastRunPath);
  const summary = {
    lastRunAt: new Date().toISOString(),
    mode: result.mode,
    dryRun: result.dryRun,
    stats: result.stats,
    git: result.git,
    warnings: result.warnings,
    success: result.success,
  };
  const tmp = `${lastRunFile}.tmp.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(summary, null, 2), "utf-8");
  renameSync(tmp, lastRunFile);
}

// ─────────────────────────────────────────────
// Path safety
// ─────────────────────────────────────────────

function safePath(vaultPath: string, relativePath: string): string | null {
  // Normalize vaultPath: strip trailing separators so the startsWith boundary check
  // is not bypassed by resolve("/data/vault/", "../etc/passwd") → /data/etc/passwd
  const normalizedVault = vaultPath.replace(/[/\\]+$/, "").replace(/\\/g, "/");
  const resolved = resolve(vaultPath.replace(/[/\\]+$/, ""), relativePath).replace(/\\/g, "/");
  if (!resolved.startsWith(normalizedVault + "/")) return null; // path traversal
  return resolved;
}

// ─────────────────────────────────────────────
// Conflict detection
// ─────────────────────────────────────────────

function archiveConflict(
  vaultPath: string,
  relativePath: string,
  diskContent: string
): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const conflictDir = join(vaultPath, ".noosphere-sync", "conflicts");
  if (!existsSync(conflictDir)) mkdirSync(conflictDir, { recursive: true });
  const safeName = relativePath.replace(/\//g, "---");
  const conflictFile = join(conflictDir, `${timestamp}-${safeName}`);
  writeFileSync(conflictFile, diskContent, "utf-8");
  return `.noosphere-sync/conflicts/${timestamp}-${safeName}`;
}

// ─────────────────────────────────────────────
// Trash handling for deleted articles
// ─────────────────────────────────────────────

function trashFile(vaultPath: string, absolutePath: string): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const trashDir = join(vaultPath, ".noosphere-sync", "trash");
  if (!existsSync(trashDir)) mkdirSync(trashDir, { recursive: true });
  const rel = pathRelative(vaultPath, absolutePath);
  const trashPath = join(trashDir, `${timestamp}-${rel.replace(/\//g, "---")}`);
  try {
    renameSync(absolutePath, trashPath);
  } catch {
    // Cross-device: copy then delete
    try {
      writeFileSync(trashPath, readFileSync(absolutePath));
      unlinkSync(absolutePath);
    } catch (e) {
      console.error("[obsidian-sync] Failed to trash file:", absolutePath, e);
    }
  }
}

// ─────────────────────────────────────────────
// Atomic file write
// ─────────────────────────────────────────────

function writeFileAtomic(absolutePath: string, content: string): void {
  const dir = absolutePath.slice(0, absolutePath.lastIndexOf("/"));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${absolutePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, absolutePath);
}

// ─────────────────────────────────────────────
// Activity log helper
// ─────────────────────────────────────────────

async function logActivity(
  title: string,
  details: Record<string, unknown>,
  authorName?: string
): Promise<void> {
  try {
    await prisma.activityLog.create({
      data: {
        type: "sync-obsidian",
        title,
        details: details as Prisma.InputJsonValue,
        authorName: authorName ?? "System",
      },
    });
  } catch (e) {
    console.error("[obsidian-sync] Failed to write activity log", e);
  }
}

// ─────────────────────────────────────────────
// Main sync runner
// ─────────────────────────────────────────────

export async function runObsidianSync(options: SyncOptions): Promise<SyncResult> {
  const startTime = Date.now();
  const warnings: string[] = [];
  const syncedAt = new Date().toISOString();

  // ── Load config ──────────────────────────────────────────────────────────
  let config: ObsidianSyncConfig;
  try {
    config = getObsidianSyncConfig()!;
  } catch (err) {
    throw new Error(`Invalid obsidian sync config: ${(err as Error).message}`);
  }

  const vaultPath = config.vaultPath;

  // ── Acquire lock ─────────────────────────────────────────────────────────
  const locked = await acquireLock();
  if (!locked) {
    throw new SyncConflictError("Another sync is already in progress");
  }

  try {
    // ── Ensure vault root exists ─────────────────────────────────────────
    if (!options.dryRun && !existsSync(vaultPath)) {
      mkdirSync(vaultPath, { recursive: true });
    }

    // ── Read manifest ──────────────────────────────────────────────────────
    const manifest = readManifest(vaultPath, config) ?? {
      version: 1,
      vaultPath,
      lastRunAt: new Date().toISOString(),
      articles: {},
    };

    // ── Build topic map ────────────────────────────────────────────────────
    const topics = await prisma.topic.findMany({
      select: { id: true, slug: true, parentId: true, name: true },
    });
    const topicMap = new Map<string, TopicNode>(
      topics.map((t) => [t.id, { id: t.id, slug: t.slug, parentId: t.parentId, name: t.name }])
    );

    // ── Load articles ──────────────────────────────────────────────────────
    const articleWhere: Prisma.ArticleWhereInput = { deletedAt: null };
    if (options.articleIds && options.articleIds.length > 0) {
      articleWhere.id = { in: options.articleIds };
    }
    if (options.topicIds && options.topicIds.length > 0) {
      const includeDescendantIds = new Set<string>(options.topicIds);
      for (const tid of options.topicIds) {
        function collectDescendants(parentId: string) {
          for (const t of topics) {
            if (t.parentId === parentId) {
              includeDescendantIds.add(t.id);
              collectDescendants(t.id);
            }
          }
        }
        collectDescendants(tid);
      }
      articleWhere.topicId = { in: [...includeDescendantIds] };
    }

    const articles = await prisma.article.findMany({
      where: articleWhere,
      include: {
        topic: { select: { id: true, slug: true, name: true } },
        tags: { include: { tag: { select: { name: true, slug: true } } } },
      },
      orderBy: { topic: { name: "asc" } },
    });

    // ── Stats ───────────────────────────────────────────────────────────────
    const stats: SyncStats = {
      scanned: articles.length,
      written: 0,
      updated: 0,
      created: 0,
      unchanged: 0,
      deleted: 0,
      skipped: 0,
      conflictsDetected: 0,
      durationMs: 0,
    };

    const managedPaths: string[] = [];

    // ── Process each article ───────────────────────────────────────────────
    for (const article of articles) {
      let lastWrittenHash: string | null = null;
      const topicPath = buildTopicPath(topicMap, article.topicId);
      const relativePath = buildArticlePath(topicPath, article.slug);
      const canonicalHash = computeContentHash(article, topicPath);
      const existingEntry = manifest.articles[article.id];

      const pathChanged = existingEntry && existingEntry.path !== relativePath;
      const contentChanged =
        !existingEntry ||
        pathChanged ||
        existingEntry.updatedAt !== article.updatedAt.toISOString() ||
        existingEntry.contentHash !== canonicalHash;
      const hasEmptyWrittenHash = existingEntry?.writtenHash === "";

      const isNew = !existingEntry;
      const shouldWrite = options.mode === "full" || !existingEntry || contentChanged || hasEmptyWrittenHash;

      if (shouldWrite && !options.dryRun) {
        const safe = safePath(vaultPath, relativePath);
        if (!safe) {
          warnings.push(`Path traversal rejected: ${relativePath}`);
          stats.skipped++;
          continue;
        }

        // Conflict detection: check if local file was modified since last sync.
        // Compares the on-disk hash against the hash of the exact bytes we last
        // wrote (writtenHash from manifest). Previous versions compared against
        // canonicalHash (computed with fake timestamp), which never matched the
        // real file on disk — causing every file to appear as a conflict.
        //
        // For manifests created before writtenHash existed, we treat the current
        // disk hash as the baseline (no conflict on first run with new format).
        // A persisted empty string is different: it came from the short-lived
        // sentinel fallback and must be treated as invalid so we archive before
        // rewriting rather than silently blessing the current disk state.
        if (existsSync(safe) && existingEntry) {
          try {
            const diskBuffer = readFileSync(safe);
            const diskHash = createHash("sha256").update(diskBuffer).digest("hex");
            const baseline = existingEntry.writtenHash ?? diskHash;
            if (diskHash !== baseline) {
              // File on disk differs from what we last wrote — genuine local modification.
              stats.conflictsDetected++;
              if (config.preserveLocalChanges) {
                const diskContent = diskBuffer.toString("utf-8");
                const backupRel = archiveConflict(vaultPath, relativePath, diskContent);
                try {
                  await recordSyncConflictReview(
                    buildSyncConflictReviewCreateInput({
                      article,
                      direction: "vault-to-noosphere",
                      relativePath,
                      archivePath: backupRel,
                      noosphereHash: canonicalHash,
                      markdownContent: diskContent,
                    })
                  );
                } catch (error) {
                  warnings.push(`Conflict review record failed: ${relativePath}`);
                  console.error("[obsidian-sync] Failed to record conflict review", error);
                }
                warnings.push(`Local modification preserved: ${relativePath} → ${backupRel}`);
              } else {
                warnings.push(`Local modification overwritten by database: ${relativePath}`);
              }
            }
          } catch {
            // File deleted or unreadable between existsSync and readFileSync —
            // skip conflict detection and proceed to write (re-creating the file).
          }
        }

        const markdown = renderMarkdown(article, topicPath, canonicalHash, syncedAt, config.publish);
        writeFileAtomic(safe, markdown);
        managedPaths.push(relativePath);

        if (isNew) stats.created++;
        else if (existingEntry) stats.updated++;
        stats.written++;

        // Compute writtenHash from the exact bytes written to disk
        lastWrittenHash = createHash("sha256").update(markdown).digest("hex");
      } else if (!shouldWrite) {
        // shouldWrite is false only when mode != "full", existingEntry exists,
        // content hasn't changed, and no legacy empty writtenHash needs repair.
        stats.unchanged++;
        // lastWrittenHash stays null from loop initialization — no new write.
      }

      // Update manifest entry — store writtenHash for accurate conflict detection
      // on the next sync. This is the hash of the exact bytes on disk.
      // When we didn't write (unchanged), preserve the existing writtenHash.
      manifest.articles[article.id] = {
        path: relativePath,
        updatedAt: article.updatedAt.toISOString(),
        contentHash: canonicalHash,
        writtenHash: lastWrittenHash ?? existingEntry?.writtenHash,
        deletedAt: null,
      };
    }

    // ── Handle deleted articles ─────────────────────────────────────────────
    // Only clean articles that are actually soft-deleted in the DB. Never delete
    // articles just because they were absent from a filtered sync result.
    const wasFiltered =
      (options.articleIds && options.articleIds.length > 0) ||
      (options.topicIds && options.topicIds.length > 0);

    if (options.clean && !options.dryRun && !wasFiltered) {
      const deletedArticles = await prisma.article.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true },
      });
      const deletedIds = new Set(deletedArticles.map((a) => a.id));

      for (const [articleId, entry] of Object.entries(manifest.articles)) {
        if (!deletedIds.has(articleId)) continue;

        const safeAbsPath = safePath(vaultPath, entry.path);
        if (!safeAbsPath) {
          warnings.push(`Path traversal rejected during deletion: ${entry.path}`);
          stats.skipped++;
          delete manifest.articles[articleId];
          continue;
        }
        if (existsSync(safeAbsPath)) {
          if (config.trashDeletions) {
            trashFile(vaultPath, safeAbsPath);
          } else {
            unlinkSync(safeAbsPath);
          }
          stats.deleted++;
          warnings.push(`Removed soft-deleted mirror: ${entry.path}`);
        }

        delete manifest.articles[articleId];
      }
    }

    // ── Build result before writing manifests ──────────────────────────────
    const result: SyncResult = {
      success: true,
      mode: options.mode,
      dryRun: options.dryRun,
      vaultPath,
      git: {
        enabled: config.gitEnabled,
        attempted: false,
        committed: false,
        commitHash: null,
        branch: null,
      },
      stats,
      manifest: {
        updated: true,
        path: join(vaultPath, config.manifestPath),
      },
      warnings,
    };

    // ── Write manifest ────────────────────────────────────────────────────
    if (!options.dryRun) {
      manifest.lastRunAt = syncedAt;
      writeManifest(vaultPath, config, manifest);
      writeLastRun(vaultPath, config, result);
    }

    // ── Git integration ───────────────────────────────────────────────────
    if (config.gitEnabled && options.git && !options.dryRun) {
      const isRepo = await isGitRepo(vaultPath);
      if (isRepo) {
        const branch = await getCurrentBranch(vaultPath);
        const statusOutput = await gitStatusPorcelain(vaultPath);

        result.git.attempted = true;
        result.git.branch = branch;

        if (statusOutput.trim()) {
          try {
            await gitAddManaged(vaultPath, managedPaths);
            const commitResult = await gitCommit(vaultPath, stats, warnings);
            if (commitResult.hash) {
              result.git.committed = true;
              result.git.commitHash = commitResult.hash;
            } else {
              result.git.error = commitResult.error;
            }
          } catch (e) {
            result.git.error = (e as Error).message;
          }
        }
      } else {
        result.git.error = "Vault is not a git repository";
      }
    }

    // ── Activity log ──────────────────────────────────────────────────────
    if (!options.dryRun) {
      await logActivity(
        `Obsidian shadow sync ${options.dryRun ? "(dry-run)" : ""}`,
        {
          mode: options.mode,
          dryRun: options.dryRun,
          vaultPath,
          stats,
          git: result.git,
          warnings,
        },
        options.callerName
      );
    }

    result.stats.durationMs = Date.now() - startTime;
    return result;
  } finally {
    await releaseLock();
  }
}

// ─────────────────────────────────────────────
// Error types
// ─────────────────────────────────────────────

export class SyncConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncConflictError";
  }
}
