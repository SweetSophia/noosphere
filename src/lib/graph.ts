import { Buffer } from "node:buffer";

export const GRAPH_ARTICLE_LIMIT_DEFAULT = 100;
export const GRAPH_ARTICLE_LIMIT_MAX = 500;
export const GRAPH_CONTENT_LIMIT_DEFAULT = 100;
export const GRAPH_CONTENT_MAX_BYTES_DEFAULT = 50 * 1024;
export const GRAPH_CONTENT_MAX_BYTES_MAX = 50 * 1024;

function parseIntegerParam(
  searchParams: URLSearchParams,
  name: string,
  fallback: number
) {
  const value = searchParams.get(name);
  if (value === null) return fallback;

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

export function parseGraphQueryParams(searchParams: URLSearchParams) {
  const limit = clamp(
    parseIntegerParam(searchParams, "limit", GRAPH_ARTICLE_LIMIT_DEFAULT),
    1,
    GRAPH_ARTICLE_LIMIT_MAX
  );

  const contentLimit = clamp(
    parseIntegerParam(searchParams, "contentLimit", GRAPH_CONTENT_LIMIT_DEFAULT),
    0,
    limit
  );

  const contentMaxBytes = clamp(
    parseIntegerParam(
      searchParams,
      "contentMaxBytes",
      GRAPH_CONTENT_MAX_BYTES_DEFAULT
    ),
    0,
    GRAPH_CONTENT_MAX_BYTES_MAX
  );

  return { limit, contentLimit, contentMaxBytes };
}

export function isContentWithinByteLimit(content: string, maxBytes: number) {
  if (maxBytes <= 0) return false;
  if (content.length > maxBytes) return false;

  return Buffer.byteLength(content, "utf8") <= maxBytes;
}

export function buildArticleLookupMaps<
  TArticle extends { slug: string; topic: { slug: string } },
>(articles: TArticle[]) {
  const articleBySlug = new Map<string, TArticle>();
  const articleByTopicSlug = new Map<string, TArticle>();

  for (const article of articles) {
    const slug = article.slug.toLowerCase();
    const topicSlug = article.topic.slug.toLowerCase();

    if (!articleBySlug.has(slug)) {
      articleBySlug.set(slug, article);
    }

    articleByTopicSlug.set(`${topicSlug}:${slug}`, article);
  }

  return { articleBySlug, articleByTopicSlug };
}
