import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission, buildScopeFilter } from "@/lib/api/auth";
import { rateLimit } from "@/lib/rate-limit";
import { validateSlug } from "@/lib/validation";
import {
  buildArticleLookupMaps,
  isContentWithinByteLimit,
  parseGraphQueryParams,
} from "@/lib/graph";

// GET /api/graph — Wiki knowledge graph
//
// Returns nodes and edges representing the wiki's connection structure.
// Powers a graph visualization (or lets agents reason about connectivity).
//
// Query params:
//   topic    — filter to a specific topic slug
//   limit    — max articles to include per topic (default 100, max 500)
//   contentLimit — max articles to parse for cross-references (default 100)
//                    Articles beyond this get topic/tag edges only.
//   contentMaxBytes — skip cross-ref parsing for articles larger than this
//                       (default 50KB, max 50KB) to prevent CPU exhaustion.
//
// Response:
//   {
//     nodes:  [{ id, title, slug, topicSlug, excerpt, tags, createdAt }],
//     edges:  [{ source, target, type: "tag" | "topic" | "cross_ref" }],
//     stats:  { articleCount, tagCount, topicCount, edgeCount }
//   }

export async function GET(request: NextRequest) {
  const rl = await rateLimit(request, { windowMs: 60_000, maxRequests: 10, keyPrefix: "graph" });
  if (!rl.allowed) return rl.response;

  // Auth: API key (any permission) or session — empty array = any authenticated caller
  const auth = await requirePermission(request, []);
  if (!auth.success) {
    return auth.response;
  }

  try {
    const { searchParams } = new URL(request.url);
    const rawTopicSlug = searchParams.get("topic");
    let topicSlug: string | undefined = undefined;
    if (rawTopicSlug) {
      const topicValidation = validateSlug(rawTopicSlug);
      if (!topicValidation.ok) {
        return NextResponse.json({ error: topicValidation.error }, { status: 400 });
      }
      topicSlug = topicValidation.slug;
    }
    const { limit, contentLimit, contentMaxBytes } =
      parseGraphQueryParams(searchParams);

    // Build scope-filtered where clause — restricts articles based on key scopes
    const scopeWhere = buildScopeFilter(auth.auth.allowedScopes, { deletedAt: null });

    // Fetch graph metadata first. Article content is loaded separately for the
    // small cross-reference candidate set so large bodies are not returned just
    // to build topic/tag edges.
    const articles = await prisma.article.findMany({
      where: {
        ...scopeWhere,
        ...(topicSlug ? { topic: { slug: topicSlug } } : {}),
      },
      select: {
        id: true,
        title: true,
        slug: true,
        excerpt: true,
        createdAt: true,
        topic: { select: { slug: true } },
        tags: { select: { tag: { select: { id: true, name: true, slug: true } } } },
      },
      take: limit,
      orderBy: { updatedAt: "desc" },
    });

    // Load content only for candidate articles. PostgreSQL enforces the byte
    // ceiling before returning content, so oversized bodies become NULL instead
    // of being transferred to Node just to be skipped.
    const candidateArticleIds = articles.slice(0, contentLimit).map((a) => a.id);
    const articleContents =
      candidateArticleIds.length > 0 && contentMaxBytes > 0
        ? await prisma.$queryRaw<Array<{ id: string; content: string | null }>>`
            SELECT id,
                   CASE
                     WHEN octet_length(content) <= ${contentMaxBytes} THEN content
                     ELSE NULL
                   END AS content
            FROM "Article"
            WHERE id IN (${Prisma.join(candidateArticleIds)})
          `
        : [];
    const contentByArticleId = new Map(
      articleContents
        .filter((row): row is { id: string; content: string } => row.content !== null)
        .map((row) => [row.id, row.content])
    );
    const articlesToParse = articles.slice(0, contentLimit).flatMap((article) => {
      const content = contentByArticleId.get(article.id);
      if (!content || !isContentWithinByteLimit(content, contentMaxBytes)) {
        return [];
      }

      return [{ ...article, content }];
    });
    const { articleBySlug, articleByTopicSlug } = buildArticleLookupMaps(articles);

  // Build nodes
  const nodes = articles.map((a) => ({
    id: a.id,
    title: a.title,
    slug: a.slug,
    topicSlug: a.topic.slug,
    excerpt: a.excerpt,
    tags: a.tags.map((t) => t.tag.slug),
    createdAt: a.createdAt,
  }));

  // Build edges using O(1) Set lookups instead of O(n) edges.some()
  // Key format: "sortedId1:sortedId2:type" — same pair + same type = duplicate
  const seenEdges = new Set<string>();
  const edges: { source: string; target: string; type: string }[] = [];

  function addEdge(source: string, target: string, type: string) {
    if (source === target) return;
    const key = [source, target].sort().join(":") + ":" + type;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ source, target, type });
  }

  // Topic edges: articles in the same topic are connected
  const byTopic = new Map<string, string[]>();
  for (const article of articles) {
    const list = byTopic.get(article.topic.slug) ?? [];
    list.push(article.id);
    byTopic.set(article.topic.slug, list);
  }

  for (const [, ids] of byTopic) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        addEdge(ids[i], ids[j], "topic");
      }
    }
  }

  // Tag edges: articles sharing a tag are connected
  const byTag = new Map<string, string[]>();
  for (const article of articles) {
    for (const { tag } of article.tags) {
      const list = byTag.get(tag.id) ?? [];
      list.push(article.id);
      byTag.set(tag.id, list);
    }
  }

  for (const [, ids] of byTag) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        addEdge(ids[i], ids[j], "tag");
      }
    }
  }

  // Cross-reference edges: articles that explicitly link to other articles in the wiki
  // Detect wikilink-style references: [[slug]] or [text](/wiki/topic/slug)
  // Only parsed for articles within contentLimit and contentMaxBytes to prevent
  // CPU exhaustion on large wikis. contentMaxBytes is capped server-side even
  // when the query string asks for more. For full accuracy, cross-references
  // should be pre-computed at write time and stored in the ArticleRelation table.
  for (const article of articlesToParse) {
    // Match [[slug]] patterns (wikilinks to other wiki pages)
    const wikiLinkRegex = /\[\[([a-z0-9-]+)\]\]/gi;
    let match;
    while ((match = wikiLinkRegex.exec(article.content)) !== null) {
      const targetSlug = match[1].toLowerCase();
      const target = articleBySlug.get(targetSlug);
      if (target) {
        addEdge(article.id, target.id, "cross_ref");
      }
    }

    // Match /wiki/[topic]/[slug] href patterns
    const hrefRegex = /\/wiki\/([a-z0-9-]+)\/([a-z0-9-]+)/gi;
    while ((match = hrefRegex.exec(article.content)) !== null) {
      const refTopic = match[1].toLowerCase();
      const refSlug = match[2].toLowerCase();
      const target = articleByTopicSlug.get(`${refTopic}:${refSlug}`);
      if (target) {
        addEdge(article.id, target.id, "cross_ref");
      }
    }
  }

  // Stats — article count is scope-filtered; tag/topic counts are not restricted
  const [articleCount, tagCount, topicCount] = await Promise.all([
    prisma.article.count({ where: scopeWhere }),
    prisma.tag.count(),
    prisma.topic.count(),
  ]);

    return NextResponse.json({
      nodes,
      edges,
      stats: {
        articleCount,
        tagCount,
        topicCount,
        edgeCount: edges.length,
      },
    });
  } catch (error) {
    console.error("[GET /api/graph]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
