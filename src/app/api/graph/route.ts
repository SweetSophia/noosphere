import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/graph — Wiki knowledge graph
//
// Returns nodes and edges representing the wiki's connection structure.
// Powers a graph visualization (or lets agents reason about connectivity).
//
// Query params:
//   topic    — filter to a specific topic slug
//   limit    — max articles to include per topic (default 100)
//
// Response:
//   {
//     nodes:  [{ id, title, slug, topicSlug, excerpt, tags, createdAt }],
//     edges:  [{ source, target, type: "tag" | "topic" | "cross_ref" }],
//     stats:  { articleCount, tagCount, topicCount, edgeCount }
//   }

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const topicSlug = searchParams.get("topic");
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "100", 10), 500);

  // Fetch all non-deleted articles with their tags and topic
  const articles = await prisma.article.findMany({
    where: {
      deletedAt: null,
      ...(topicSlug ? { topic: { slug: topicSlug } } : {}),
    },
    select: {
      id: true,
      title: true,
      slug: true,
      excerpt: true,
      content: true,
      createdAt: true,
      topic: { select: { slug: true } },
      tags: { select: { tag: { select: { id: true, name: true, slug: true } } } },
    },
    take: limit,
    orderBy: { updatedAt: "desc" },
  });

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

  // Build edges
  const edges: { source: string; target: string; type: string }[] = [];

  // Topic edges: articles in the same topic are connected
  // Only add for article pairs (avoid doubling edges for small topics)
  const byTopic = new Map<string, string[]>();
  for (const article of articles) {
    const list = byTopic.get(article.topic.slug) ?? [];
    list.push(article.id);
    byTopic.set(article.topic.slug, list);
  }

  for (const [, ids] of byTopic) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        edges.push({ source: ids[i], target: ids[j], type: "topic" });
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
        // Avoid duplicate topic edges
        if (
          !edges.some(
            (e) =>
              (e.source === ids[i] && e.target === ids[j]) ||
              (e.source === ids[j] && e.target === ids[i])
          )
        ) {
          edges.push({ source: ids[i], target: ids[j], type: "tag" });
        }
      }
    }
  }

  // Cross-reference edges: articles that explicitly link to other articles in the wiki
  // Detect wikilink-style references: [[slug]] or [text](/wiki/topic/slug)
  const slugSet = new Set(articles.map((a) => a.slug));
  const topicSlugSet = new Set(articles.map((a) => a.topic.slug));

  for (const article of articles) {
    // Match [[slug]] patterns (wikilinks to other wiki pages)
    const wikiLinkRegex = /\[\[([a-z0-9-]+)\]\]/gi;
    let match;
    while ((match = wikiLinkRegex.exec(article.content)) !== null) {
      const targetSlug = match[1].toLowerCase();
      const target = articles.find((a) => a.slug === targetSlug);
      if (target && target.id !== article.id) {
        const exists = edges.some(
          (e) =>
            (e.source === article.id && e.target === target.id) ||
            (e.source === target.id && e.target === article.id)
        );
        if (!exists) {
          edges.push({ source: article.id, target: target.id, type: "cross_ref" });
        }
      }
    }

    // Match /wiki/[topic]/[slug] href patterns
    const hrefRegex = /\/wiki\/([a-z0-9-]+)\/([a-z0-9-]+)/gi;
    while ((match = hrefRegex.exec(article.content)) !== null) {
      const refTopic = match[1].toLowerCase();
      const refSlug = match[2].toLowerCase();
      const target = articles.find(
        (a) => a.topic.slug === refTopic && a.slug === refSlug
      );
      if (target && target.id !== article.id) {
        const exists = edges.some(
          (e) =>
            (e.source === article.id && e.target === target.id) ||
            (e.source === target.id && e.target === article.id)
        );
        if (!exists) {
          edges.push({ source: article.id, target: target.id, type: "cross_ref" });
        }
      }
    }
  }

  // Stats
  const [articleCount, tagCount, topicCount] = await Promise.all([
    prisma.article.count({ where: { deletedAt: null } }),
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
}
