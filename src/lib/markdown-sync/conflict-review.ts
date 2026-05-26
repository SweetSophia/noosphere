import { createHash } from "crypto";
import { resolve } from "path";
import { parseNoosphereMarkdown, readMarkdownString, readMarkdownStringArray } from "@/lib/markdown/noosphere-markdown";

export const SYNC_CONFLICT_REVIEW_STATUSES = ["open", "resolved", "ignored-once", "ignored-always"] as const;
export type SyncConflictReviewStatus = (typeof SYNC_CONFLICT_REVIEW_STATUSES)[number];

export const SYNC_CONFLICT_REVIEW_ACTIONS = [
  "keep-noosphere",
  "keep-markdown",
  "mark-resolved",
  "ignore-once",
  "ignore-always",
] as const;
export type SyncConflictReviewAction = (typeof SYNC_CONFLICT_REVIEW_ACTIONS)[number];

export interface SyncConflictReviewArticleInput {
  id: string;
  title: string;
  slug: string;
  updatedAt: Date;
  status: string;
  confidence: string | null;
  topic: { slug: string; name: string };
  tags?: Array<{ tag: { slug: string; name: string } }>;
}

export interface SyncConflictReviewSummary {
  noosphere: {
    title: string;
    slug: string;
    topic: string;
    updatedAt: string;
    status: string;
    confidence: string | null;
    tags: string[];
    contentHash: string | null;
  };
  markdown: {
    title: string | null;
    slug: string | null;
    topic: string | null;
    updatedAt: string | null;
    status: string | null;
    confidence: string | null;
    tags: string[];
    contentHash: string;
    parseError: string | null;
  };
}

export interface SyncConflictReviewCreateInput {
  articleId: string;
  direction: "noosphere-to-vault" | "vault-to-noosphere";
  relativePath: string;
  archivePath: string;
  noosphereHash: string | null;
  markdownHash: string;
  noosphereUpdatedAt: Date | null;
  markdownUpdatedAt: Date | null;
  summary: SyncConflictReviewSummary;
}

export function isSyncConflictReviewAction(value: unknown): value is SyncConflictReviewAction {
  return typeof value === "string" && SYNC_CONFLICT_REVIEW_ACTIONS.includes(value as SyncConflictReviewAction);
}

export function statusForSyncConflictReviewAction(action: SyncConflictReviewAction): SyncConflictReviewStatus {
  switch (action) {
    case "ignore-once":
      return "ignored-once";
    case "ignore-always":
      return "ignored-always";
    default:
      return "resolved";
  }
}

export function hashMarkdownContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function buildSyncConflictReviewSummary(
  article: SyncConflictReviewArticleInput,
  markdownContent: string,
  noosphereHash: string | null,
): SyncConflictReviewSummary {
  const parsed = parseNoosphereMarkdown(markdownContent);
  const markdownHash = hashMarkdownContent(markdownContent);

  if (!parsed.ok) {
    return {
      noosphere: noosphereSummary(article, noosphereHash),
      markdown: {
        title: null,
        slug: null,
        topic: null,
        updatedAt: null,
        status: null,
        confidence: null,
        tags: [],
        contentHash: markdownHash,
        parseError: parsed.error,
      },
    };
  }

  const frontmatter = parsed.markdown.frontmatter;
  const updatedAt = readMarkdownString(frontmatter, "updatedAt") ?? readNoosphereSyncedAt(frontmatter);

  return {
    noosphere: noosphereSummary(article, noosphereHash),
    markdown: {
      title: readMarkdownString(frontmatter, "title") ?? null,
      slug: readMarkdownString(frontmatter, "slug") ?? null,
      topic: readMarkdownString(frontmatter, "topic") ?? null,
      updatedAt: updatedAt ?? null,
      status: readMarkdownString(frontmatter, "status") ?? null,
      confidence: readMarkdownString(frontmatter, "confidence") ?? null,
      tags: readMarkdownStringArray(frontmatter, "tags"),
      contentHash: markdownHash,
      parseError: null,
    },
  };
}

export function buildSyncConflictReviewCreateInput(args: {
  article: SyncConflictReviewArticleInput;
  direction: "noosphere-to-vault" | "vault-to-noosphere";
  relativePath: string;
  archivePath: string;
  noosphereHash: string | null;
  markdownContent: string;
}): SyncConflictReviewCreateInput {
  const summary = buildSyncConflictReviewSummary(args.article, args.markdownContent, args.noosphereHash);
  const markdownUpdatedAt = summary.markdown.updatedAt ? new Date(summary.markdown.updatedAt) : null;

  return {
    articleId: args.article.id,
    direction: args.direction,
    relativePath: args.relativePath,
    archivePath: args.archivePath,
    noosphereHash: args.noosphereHash,
    markdownHash: summary.markdown.contentHash,
    noosphereUpdatedAt: args.article.updatedAt,
    markdownUpdatedAt: markdownUpdatedAt && !Number.isNaN(markdownUpdatedAt.valueOf()) ? markdownUpdatedAt : null,
    summary,
  };
}

export function resolveVaultArchivePath(vaultPath: string, archivePath: string): string | null {
  const normalizedVault = vaultPath.replace(/[/\\]+$/, "");
  const conflictRoot = resolve(normalizedVault, ".noosphere-sync", "conflicts").replace(/\\/g, "/");
  const absolutePath = resolve(normalizedVault, archivePath).replace(/\\/g, "/");

  if (!absolutePath.startsWith(`${conflictRoot}/`)) return null;
  return absolutePath;
}

function noosphereSummary(article: SyncConflictReviewArticleInput, contentHash: string | null) {
  return {
    title: article.title,
    slug: article.slug,
    topic: article.topic.slug,
    updatedAt: article.updatedAt.toISOString(),
    status: article.status,
    confidence: article.confidence,
    tags: article.tags?.map((item) => item.tag.slug) ?? [],
    contentHash,
  };
}

function readNoosphereSyncedAt(frontmatter: Record<string, unknown>): string | undefined {
  const noosphere = frontmatter["noosphere"];
  if (!noosphere || typeof noosphere !== "object" || Array.isArray(noosphere)) return undefined;
  const syncedAt = (noosphere as Record<string, unknown>)["syncedAt"];
  return typeof syncedAt === "string" && syncedAt.trim() ? syncedAt.trim() : undefined;
}
