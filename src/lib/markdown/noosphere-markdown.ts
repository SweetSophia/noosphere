import { createHash } from "crypto";
import yaml from "js-yaml";

export const NOOSPHERE_MARKDOWN_SCHEMA_VERSION = 1;

export interface NoosphereMarkdownArticle {
  id?: string;
  slug?: string;
  title: string;
  topic: string;
  topicPath?: string[];
  content: string;
  tags?: string[];
  restrictedTags?: string[];
  excerpt?: string | null;
  confidence?: string | null;
  status?: string | null;
  authorName?: string | null;
  sourceUrl?: string | null;
  sourceType?: string | null;
  lastReviewed?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}

export interface RenderNoosphereMarkdownOptions {
  contentHash?: string;
  syncedAt?: string;
  publish?: boolean;
  sourceOfTruth?: "database" | "markdown";
}

export interface ParsedNoosphereMarkdown {
  frontmatter: Record<string, unknown>;
  content: string;
}

export type NoosphereMarkdownParseResult =
  | { ok: true; markdown: ParsedNoosphereMarkdown }
  | { ok: false; error: "No YAML frontmatter found" | "Invalid YAML frontmatter" };

const FRONTMATTER_KEYS = [
  "id", "slug", "title", "topic", "topicPath",
  "confidence", "status", "tags", "restrictedTags", "excerpt",
  "authorName", "sourceUrl", "sourceType", "lastReviewed",
  "createdAt", "updatedAt", "noosphere", "publish",
] as const;

function isoString(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeStringArray(values: string[] | undefined): string[] {
  if (!values) return [];
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function normalizeMarkdownArrayValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

type BuildFrontmatterRecordOptions = Omit<RenderNoosphereMarkdownOptions, "contentHash"> & {
  contentHash?: string | null;
};

function buildFrontmatterRecord(
  article: NoosphereMarkdownArticle,
  options: BuildFrontmatterRecordOptions = {}
): Record<string, unknown> {
  const topicPath = article.topicPath && article.topicPath.length > 0
    ? article.topicPath
    : [article.topic];
  const syncedAt = options.syncedAt ?? new Date().toISOString();
  const sourceOfTruth = options.sourceOfTruth ?? "database";

  const fm: Record<string, unknown> = {
    title: article.title,
    topic: article.topic,
    topicPath,
    noosphere: {
      entity: "article",
      schemaVersion: NOOSPHERE_MARKDOWN_SCHEMA_VERSION,
      syncedAt,
      sourceOfTruth,
    },
  };

  if (options.contentHash) {
    (fm.noosphere as Record<string, unknown>).contentHash = `sha256:${options.contentHash}`;
  }

  if (article.id) fm.id = article.id;
  if (article.slug) fm.slug = article.slug;
  if (article.confidence) fm.confidence = article.confidence;
  if (article.status) fm.status = article.status;

  const tags = normalizeStringArray(article.tags);
  if (tags.length > 0) fm.tags = tags;

  const restrictedTags = normalizeStringArray(article.restrictedTags);
  if (restrictedTags.length > 0) fm.restrictedTags = restrictedTags;

  if (article.excerpt) fm.excerpt = article.excerpt;
  if (article.authorName) fm.authorName = article.authorName;
  if (article.sourceUrl) fm.sourceUrl = article.sourceUrl;
  if (article.sourceType) fm.sourceType = article.sourceType;

  const lastReviewed = isoString(article.lastReviewed);
  if (lastReviewed) fm.lastReviewed = lastReviewed;

  const createdAt = isoString(article.createdAt);
  if (createdAt) fm.createdAt = createdAt;

  const updatedAt = isoString(article.updatedAt);
  if (updatedAt) fm.updatedAt = updatedAt;

  if (article.slug) {
    (fm.noosphere as Record<string, unknown>).url = `/wiki/${[...topicPath, article.slug].join("/")}`;
  }
  if (options.publish) fm.publish = true;

  const ordered: Record<string, unknown> = {};
  for (const key of FRONTMATTER_KEYS) {
    if (fm[key] !== undefined) ordered[key] = fm[key];
  }

  return ordered;
}

function dumpFrontmatter(record: Record<string, unknown>): string {
  const yamlStr = yaml.dump(record, {
    indent: 2,
    lineWidth: -1,
    quotingType: '"',
    forceQuotes: false,
    noRefs: true,
    sortKeys: false,
  });

  return `---\n${yamlStr.trim()}\n---\n`;
}

export function buildNoosphereFrontmatter(
  article: NoosphereMarkdownArticle,
  options: RenderNoosphereMarkdownOptions = {}
): string {
  const sourceOfTruth = options.sourceOfTruth ?? "database";
  const contentHash = options.contentHash ?? computeNoosphereContentHash(article, { sourceOfTruth });
  return dumpFrontmatter(buildFrontmatterRecord(article, { ...options, contentHash, sourceOfTruth }));
}

export function renderNoosphereMarkdown(
  article: NoosphereMarkdownArticle,
  options: RenderNoosphereMarkdownOptions = {}
): string {
  return `${buildNoosphereFrontmatter(article, options)}\n${article.content}`;
}

export function computeNoosphereContentHash(
  article: NoosphereMarkdownArticle,
  options: Pick<RenderNoosphereMarkdownOptions, "sourceOfTruth"> = {}
): string {
  const stableFrontmatter = dumpFrontmatter(buildFrontmatterRecord(article, {
    syncedAt: "1970-01-01T00:00:00.000Z",
    publish: false,
    sourceOfTruth: options.sourceOfTruth,
    contentHash: null,
  }));
  return createHash("sha256")
    .update(stableFrontmatter)
    .update("\n")
    .update(article.content)
    .digest("hex");
}

export function parseNoosphereMarkdown(content: string): NoosphereMarkdownParseResult {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { ok: false, error: "No YAML frontmatter found" };
  }

  try {
    const parsed = yaml.load(match[1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "Invalid YAML frontmatter" };
    }
    return {
      ok: true,
      markdown: {
        frontmatter: parsed as Record<string, unknown>,
        content: match[2].replace(/^\r?\n/, ""),
      },
    };
  } catch {
    return { ok: false, error: "Invalid YAML frontmatter" };
  }
}

export function readMarkdownString(frontmatter: Record<string, unknown>, key: string): string | undefined {
  const value = frontmatter[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function readMarkdownStringArray(frontmatter: Record<string, unknown>, key: string): string[] {
  const value = frontmatter[key];
  if (!Array.isArray(value)) return [];
  return normalizeStringArray(
    value
      .map(normalizeMarkdownArrayValue)
      .filter((item): item is string => item !== null)
  );
}
