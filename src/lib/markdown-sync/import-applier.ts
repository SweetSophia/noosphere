/**
 * Reverse markdown import applier.
 *
 * Phase 5 of the obsidian sync pipeline: applies vault-side markdown changes
 * back into Noosphere DB. This is intentionally write-capable and requires
 * ADMIN permission.
 *
 * Core responsibilities:
 * 1. Parse and validate markdown files from the vault
 * 2. Determine whether to create, update, or skip each candidate
 * 3. Write articles to the DB (or simulate in dry-run mode)
 * 4. Record audit entries for every action taken
 * 5. Return a detailed result object with stats and warnings
 */

import { readFileSync } from "fs";
import { join } from "path";
import type { PrismaClient } from "@prisma/client";
import type {
  MarkdownImportCandidate,
  MarkdownImportMetadata,
} from "@/lib/markdown-sync/import-scanner";
import { parseNoosphereMarkdown } from "@/lib/markdown/noosphere-markdown";
import type { Manifest, ManifestEntry } from "@/lib/obsidian-sync";

export const MARKDOWN_IMPORT_APPLY_MAX_BODY_BYTES = 256 * 1024; // 256KB
export const MARKDOWN_IMPORT_APPLY_PERMISSIONS = ["ADMIN"] as const;

export type ImportApplyMode = "create" | "update" | "upsert";
export type ImportApplyAction = "created" | "updated" | "skipped" | "conflict";

export interface ImportApplyOptions {
  vaultPath: string;
  manifest: Manifest;
  candidates: MarkdownImportCandidate[];
  mode: ImportApplyMode;
  forceOverwrite: boolean;
  dryRun: boolean;
  performedBy: string;
}

export interface ImportApplyResult {
  success: boolean;
  dryRun: boolean;
  vaultPath: string;
  stats: {
    total: number;
    created: number;
    updated: number;
    skipped: number;
    conflicts: number;
    durationMs: number;
  };
  // One entry per candidate, in the same order as input
  results: ImportApplyCandidateResult[];
  warnings: string[];
}

export interface ImportApplyCandidateResult {
  candidate: MarkdownImportCandidate;
  action: ImportApplyAction | null;
  articleId: string | null;
  conflictReason: string | null;
  warning: string | null;
}

/**
 * Main entry point: apply markdown imports from a list of scan candidates.
 */
export async function applyMarkdownImports(
  prisma: PrismaClient,
  options: ImportApplyOptions
): Promise<ImportApplyResult> {
  const startMs = Date.now();
  const { vaultPath, manifest, candidates, mode, forceOverwrite, dryRun, performedBy } = options;

  const results: ImportApplyCandidateResult[] = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let conflicts = 0;
  const warnings: string[] = [];

  for (const candidate of candidates) {
    const result = await applySingleCandidate(prisma, {
      candidate,
      vaultPath,
      manifest,
      mode,
      forceOverwrite,
      dryRun,
      performedBy,
    });

    results.push(result);

    if (dryRun) {
      // In dry-run mode, we report what WOULD have happened
      if (result.action === "created") created++;
      else if (result.action === "updated") updated++;
      else if (result.action === "conflict") conflicts++;
      else skipped++;
    } else {
      // In real mode, we count what actually happened
      if (result.action === "created") created++;
      else if (result.action === "updated") updated++;
      else if (result.action === "conflict") conflicts++;
      else skipped++;
    }

    if (result.warning) {
      warnings.push(result.warning);
    }
  }

  return {
    success: true,
    dryRun,
    vaultPath,
    stats: {
      total: candidates.length,
      created,
      updated,
      skipped,
      conflicts,
      durationMs: Date.now() - startMs,
    },
    results,
    warnings,
  };
}

interface ApplySingleOptions {
  candidate: MarkdownImportCandidate;
  vaultPath: string;
  manifest: Manifest;
  mode: ImportApplyMode;
  forceOverwrite: boolean;
  dryRun: boolean;
  performedBy: string;
}

async function applySingleCandidate(
  prisma: PrismaClient,
  options: ApplySingleOptions
): Promise<ImportApplyCandidateResult> {
  const { candidate, vaultPath, manifest, mode, forceOverwrite, dryRun, performedBy } = options;
  const absolutePath = join(vaultPath, candidate.relativePath);

  // ── Handle `missing` candidates ──────────────────────────────────────────
  // A "missing" candidate means the file existed before but is now gone.
  // We don't delete DB articles automatically (DB wins). Skip silently.
  if (candidate.kind === "missing") {
    await recordAudit(prisma, {
      articleId: candidate.articleId,
      relativePath: candidate.relativePath,
      action: "skipped",
      kind: "missing",
      dryRun,
      mode,
      forceOverwrite,
      markdownHash: candidate.markdownHash ?? null,
      noosphereHash: null,
      conflictReason: "File is missing from vault — DB article untouched.",
      performedBy,
    });

    return {
      candidate,
      action: "skipped",
      articleId: candidate.articleId,
      conflictReason: "File is missing from vault — DB article untouched.",
      warning: null,
    };
  }

  // ── Handle `untracked` candidates ────────────────────────────────────────
  // Untracked files are not in the manifest and were never synced by Noosphere.
  // Only import if mode is "create" or "upsert", never "update".
  if (candidate.kind === "untracked") {
    if (mode === "update") {
      return {
        candidate,
        action: "skipped",
        articleId: null,
        conflictReason: null,
        warning: `Untracked file ${candidate.relativePath} skipped in "update" mode. Use "create" or "upsert" to import.`,
      };
    }

    // Try to create a new article
    return applyCreateOrUpdate(prisma, {
      candidate,
      absolutePath,
      vaultPath,
      manifest,
      mode,
      forceOverwrite,
      dryRun,
      performedBy,
    });
  }

  // ── Handle `modified` and `baseline-missing` candidates ──────────────────
  // These are files that Noosphere previously wrote (or tried to write).
  // We need to decide whether to update the DB or skip due to conflict.
  if (candidate.kind === "modified" || candidate.kind === "baseline-missing") {
    // If there's an articleId, check for conflicts
    if (candidate.articleId) {
      const existingArticle = await prisma.article.findUnique({
        where: { id: candidate.articleId },
        select: { id: true, updatedAt: true, content: true },
      });

      if (existingArticle) {
        // Conflict check: if the article was updated in DB AFTER the markdown file
        // was last modified (according to the manifest's baseline hash), skip.
        if (!forceOverwrite && candidate.baselineHash) {
          const dbUpdatedAt = existingArticle.updatedAt.getTime();
          // We use the markdown file's mtime as a proxy for when it was last changed.
          // If we have a manifest entry with writtenHash, we compare.
          const manifestEntry = findManifestEntry(manifest, candidate.relativePath);
          if (manifestEntry) {
            // The file has been modified since Noosphere last wrote it.
            // Check if DB is newer than the file change.
            // Since we don't have the exact file mtime in the candidate, we use
            // the markdownHash comparison as a proxy.
            // If markdownHash !== baselineHash, the file was modified.
            if (candidate.markdownHash !== candidate.baselineHash) {
              // File has been modified since baseline. This is expected for "modified" candidates.
              // For baseline-missing, we don't have a baseline, so we can't do this check.
              // We only conflict if forceOverwrite is false and mode is "update".
              if (!forceOverwrite && mode === "update") {
                // In update mode without force, we skip if there's an existing article
                // to avoid accidentally overwriting newer DB content.
                await recordAudit(prisma, {
                  articleId: candidate.articleId,
                  relativePath: candidate.relativePath,
                  action: "conflict",
                  kind: candidate.kind,
                  dryRun,
                  mode,
                  forceOverwrite,
                  markdownHash: candidate.markdownHash ?? null,
                  noosphereHash: candidate.baselineHash ?? null,
                  conflictReason: "Article exists in DB and mode is 'update' without forceOverwrite. Skipped to preserve DB state.",
                  performedBy,
                });

                return {
                  candidate,
                  action: "conflict",
                  articleId: candidate.articleId,
                  conflictReason: "Article exists in DB and mode is 'update' without forceOverwrite. Skipped to preserve DB state.",
                  warning: null,
                };
              }
            }
          }
        }
      }
    }

    // Determine action based on mode and whether article exists
    if (mode === "create") {
      if (candidate.articleId) {
        // Can't create if article already exists
        return {
          candidate,
          action: "skipped",
          articleId: candidate.articleId,
          conflictReason: null,
          warning: `Article ${candidate.articleId} already exists. Cannot create in "create" mode.`,
        };
      }
      // Fall through to create
    }

    // Proceed with create or update
    return applyCreateOrUpdate(prisma, {
      candidate,
      absolutePath,
      vaultPath,
      manifest,
      mode,
      forceOverwrite,
      dryRun,
      performedBy,
    });
  }

  // Unknown candidate kind — skip
  return {
    candidate,
    action: "skipped",
    articleId: candidate.articleId,
    conflictReason: null,
    warning: `Unknown candidate kind: ${candidate.kind}`,
  };
}

interface ApplyCreateOrUpdateOptions {
  candidate: MarkdownImportCandidate;
  absolutePath: string;
  vaultPath: string;
  manifest: Manifest;
  mode: ImportApplyMode;
  forceOverwrite: boolean;
  dryRun: boolean;
  performedBy: string;
}

async function applyCreateOrUpdate(
  prisma: PrismaClient,
  options: ApplyCreateOrUpdateOptions
): Promise<ImportApplyCandidateResult> {
  const { candidate, absolutePath, vaultPath, manifest, mode, forceOverwrite, dryRun, performedBy } = options;

  // ── Read and parse the markdown file ─────────────────────────────────────
  let markdownContent: string;
  try {
    markdownContent = readFileSync(absolutePath, "utf-8");
  } catch {
    await recordAudit(prisma, {
      articleId: candidate.articleId ?? null,
      relativePath: candidate.relativePath,
      action: "skipped",
      kind: candidate.kind,
      dryRun,
      mode,
      forceOverwrite,
      markdownHash: candidate.markdownHash ?? null,
      noosphereHash: null,
      conflictReason: "Could not read markdown file from disk.",
      performedBy,
    });

    return {
      candidate,
      action: "skipped",
      articleId: null,
      conflictReason: "Could not read markdown file from disk.",
      warning: null,
    };
  }

  // ── Parse frontmatter ──────────────────────────────────────────────────────
  const parseResult = parseNoosphereMarkdown(markdownContent);

  if (!parseResult.ok) {
    await recordAudit(prisma, {
      articleId: candidate.articleId ?? null,
      relativePath: candidate.relativePath,
      action: "skipped",
      kind: candidate.kind,
      dryRun,
      mode,
      forceOverwrite,
      markdownHash: candidate.markdownHash ?? null,
      noosphereHash: null,
      conflictReason: `Markdown parse error: ${parseResult.error}`,
      performedBy,
    });

    return {
      candidate,
      action: "skipped",
      articleId: null,
      conflictReason: `Markdown parse error: ${parseResult.error}`,
      warning: null,
    };
  }

  const frontmatter = parseResult.markdown.frontmatter as Record<string, unknown>;
  const body = parseResult.markdown.content;
  const metadata = candidate.metadata;

  // ── Determine topic ────────────────────────────────────────────────────────
  if (!metadata?.topic) {
    await recordAudit(prisma, {
      articleId: candidate.articleId ?? null,
      relativePath: candidate.relativePath,
      action: "skipped",
      kind: candidate.kind,
      dryRun,
      mode,
      forceOverwrite,
      markdownHash: candidate.markdownHash ?? null,
      noosphereHash: null,
      conflictReason: "Markdown has no topic in frontmatter. Cannot import without a topic.",
      performedBy,
    });

    return {
      candidate,
      action: "skipped",
      articleId: null,
      conflictReason: "Markdown has no topic in frontmatter. Cannot import without a topic.",
      warning: null,
    };
  }

  // Look up topic by slug
  const topic = await prisma.topic.findUnique({
    where: { slug: metadata.topic },
  });

  if (!topic) {
    await recordAudit(prisma, {
      articleId: candidate.articleId ?? null,
      relativePath: candidate.relativePath,
      action: "skipped",
      kind: candidate.kind,
      dryRun,
      mode,
      forceOverwrite,
      markdownHash: candidate.markdownHash ?? null,
      noosphereHash: null,
      conflictReason: `Topic '${metadata.topic}' not found in Noosphere. Create the topic first.`,
      performedBy,
    });

    return {
      candidate,
      action: "skipped",
      articleId: null,
      conflictReason: `Topic '${metadata.topic}' not found in Noosphere. Create the topic first.`,
      warning: null,
    };
  }

  // ── Determine slug ──────────────────────────────────────────────────────────
  const slug = metadata.slug ?? deriveSlugFromTitle(
    (frontmatter.title as string | null) ?? metadata.title ?? candidate.relativePath
  );

  // ── Check for existing article ──────────────────────────────────────────────
  const existingArticle = candidate.articleId
    ? await prisma.article.findUnique({ where: { id: candidate.articleId } })
    : await prisma.article.findUnique({ where: { topicId_slug: { topicId: topic.id, slug } } });

  if (existingArticle && mode === "create") {
    return {
      candidate,
      action: "skipped",
      articleId: existingArticle.id,
      conflictReason: null,
      warning: `Article with slug '${slug}' already exists in topic '${topic.slug}'. Cannot create in "create" mode.`,
    };
  }

  // ── Build article data ─────────────────────────────────────────────────────
  const articleData = {
    title: (frontmatter.title as string | null) ?? metadata?.title ?? slug,
    slug,
    content: body,
    excerpt: (frontmatter.excerpt as string | null) ?? null,
    authorName: (frontmatter.authorName as string | null) ?? null,
    topicId: topic.id,
    sourceType: "markdown-import" as const,
    sourceUrl: null,
    confidence: ((frontmatter.confidence as string) ?? "medium") as "low" | "medium" | "high",
    status: ((frontmatter.status as string) ?? "published") as "draft" | "reviewed" | "published",
    restrictedTags: (frontmatter.restrictedTags as string[] | undefined) ?? metadata?.restrictedTags ?? [],
  };

  let articleId: string;
  let action: ImportApplyAction;

  if (existingArticle) {
    if (!forceOverwrite && mode === "update") {
      // Already checked above, but double-check
      return {
        candidate,
        action: "conflict",
        articleId: existingArticle.id,
        conflictReason: "Existing article found and mode is 'update' without forceOverwrite.",
        warning: null,
      };
    }

    if (dryRun) {
      articleId = existingArticle.id;
      action = "updated";
    } else {
      // Get current hash for audit
      const currentHash = hashContent(existingArticle.content);

      const updated = await prisma.article.update({
        where: { id: existingArticle.id },
        data: articleData,
      });

      articleId = updated.id;
      action = "updated";

      // Record audit
      await recordAudit(prisma, {
        articleId,
        relativePath: candidate.relativePath,
        action: "updated",
        kind: candidate.kind,
        dryRun,
        mode,
        forceOverwrite,
        markdownHash: candidate.markdownHash ?? null,
        noosphereHash: currentHash,
        conflictReason: null,
        performedBy,
      });
    }
  } else {
    if (dryRun) {
      articleId = "(would be created)";
      action = "created";
    } else {
      const created = await prisma.article.create({
        data: articleData,
      });

      articleId = created.id;
      action = "created";

      // Record audit
      await recordAudit(prisma, {
        articleId,
        relativePath: candidate.relativePath,
        action: "created",
        kind: candidate.kind,
        dryRun,
        mode,
        forceOverwrite,
        markdownHash: candidate.markdownHash ?? null,
        noosphereHash: null,
        conflictReason: null,
        performedBy,
      });
    }
  }

  // ── Handle tags ────────────────────────────────────────────────────────────
  const tags = (frontmatter.tags as string[] | undefined) ?? metadata?.tags ?? [];
  if (!dryRun && articleId && tags.length > 0) {
    await syncArticleTags(prisma, articleId, tags);
  }

  // ── Update manifest with new written hash ──────────────────────────────────
  if (!dryRun && articleId && candidate.markdownHash) {
    await updateManifestHash(manifest, vaultPath, candidate.relativePath, candidate.markdownHash);
  }

  return {
    candidate,
    action,
    articleId,
    conflictReason: null,
    warning: null,
  };
}

async function recordAudit(
  prisma: PrismaClient,
  params: {
    articleId: string | null;
    relativePath: string;
    action: ImportApplyAction;
    kind: string;
    dryRun: boolean;
    mode: ImportApplyMode;
    forceOverwrite: boolean;
    markdownHash: string | null;
    noosphereHash: string | null;
    conflictReason: string | null;
    performedBy: string;
  }
) {
  if (params.dryRun) return; // No audit in dry-run mode

  await prisma.syncImportAudit.create({
    data: {
      articleId: params.articleId,
      relativePath: params.relativePath,
      action: params.action,
      kind: params.kind,
      dryRun: params.dryRun,
      forceOverwrite: params.forceOverwrite,
      mode: params.mode,
      markdownHash: params.markdownHash,
      noosphereHash: params.noosphereHash,
      conflictReason: params.conflictReason,
      performedBy: params.performedBy,
    },
  });
}

async function syncArticleTags(prisma: PrismaClient, articleId: string, tagNames: string[]) {
  // Remove existing tags for this article
  await prisma.articleTag.deleteMany({
    where: { articleId },
  });

  // Create or find each tag and link it
  for (const tagName of tagNames) {
    const tagSlug = slugify(tagName);
    const tag = await prisma.tag.upsert({
      where: { slug: tagSlug },
      create: { name: tagName, slug: tagSlug },
      update: {},
    });

    await prisma.articleTag.create({
      data: {
        articleId,
        tagId: tag.id,
      },
    });
  }
}

/**
 * Find a manifest entry by its relative path.
 * Note: manifest.articles is keyed by articleId, not path, so we must iterate.
 */
function findManifestEntry(manifest: Manifest, relativePath: string): ManifestEntry | undefined {
  for (const entry of Object.values(manifest.articles)) {
    if (entry.path === relativePath) {
      return entry;
    }
  }
  return undefined;
}

/**
 * Update the writtenHash for a manifest entry identified by its relative path.
 * Note: The manifest file itself should be written back by the caller
 * after all candidates are processed.
 */
function updateManifestHash(
  manifest: Manifest,
  _vaultPath: string,
  relativePath: string,
  newHash: string
): void {
  for (const entry of Object.values(manifest.articles)) {
    if (entry.path === relativePath) {
      entry.writtenHash = newHash;
      break;
    }
  }
}

function deriveSlugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 100);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

function hashContent(content: string): string {
  // Simple hash for audit logging — not cryptographic
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}
