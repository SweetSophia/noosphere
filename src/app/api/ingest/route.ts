import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiKey } from "@/lib/api/keys";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { buildTagConnections } from "@/lib/wiki";

// Security limits
const MAX_ARTICLE_CONTENT_SIZE = 1024 * 1024; // 1 MB per article
const MAX_AUTHOR_NAME_LENGTH = 100;

// POST /api/ingest — Process a source into multiple wiki articles
// Auth: API key (WRITE/ADMIN) or session (EDITOR/ADMIN)
//
// The agent (caller) reads and analyzes the source, then sends the structured
// results here. This endpoint handles bookkeeping: creating articles, linking
// tags, logging the ingest, and returning a summary.
//
// Body:
//   source:    { type: "url"|"text", url?, title }
//   articles:  [{ title, slug, topicId, content, excerpt?, tags?[], sourceUrl?, authorName? }]
//   authorName?: string  (fallback for articles that don't specify one)
//   tags?:      string[] (global tags applied to every article)
//
// Response:
//   { ingestId, created, articles: [{id, title, slug, topic}], tagsApplied }

interface IngestSource {
  type: "url" | "text";
  url?: string;
  title: string;
}

interface IngestArticle {
  title: string;
  slug: string;
  topicId: string;
  content: string;
  excerpt?: string;
  tags?: string[];
  sourceUrl?: string;
  authorName?: string;
  confidence?: string;
  status?: string;
  relatedArticleIds?: string[];
}

export async function POST(request: NextRequest) {
  // --- Auth ---
  const apiAuth = await requireApiKey(request);
  const session = await getServerSession(authOptions);

  if (!apiAuth.authorized && !session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (apiAuth.authorized) {
    if (apiAuth.permissions !== "WRITE" && apiAuth.permissions !== "ADMIN") {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }
  } else {
    const role = (session?.user as { role?: string }).role;
    if (role !== "EDITOR" && role !== "ADMIN") {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }
  }

  // --- Parse body ---
  let body: {
    source: IngestSource;
    articles: IngestArticle[];
    authorName?: string;
    tags?: string[];
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { source, articles, tags: globalTags } = body;
  // authorName from body is accepted but sanitized to prevent HTML injection / spoofing
  const rawAuthorName = body.authorName ?? "";
  const sanitizedAuthorName = rawAuthorName
    .replace(/<[^>]*>/g, "") // strip any HTML tags
    .trim()
    .slice(0, MAX_AUTHOR_NAME_LENGTH) || session?.user?.name || "Unknown";
  const userId = session?.user ? (session.user as { id?: string }).id ?? null : null;

  // --- Validate ---
  if (!source?.title) {
    return NextResponse.json({ error: "source.title is required" }, { status: 400 });
  }

  if (!articles?.length) {
    return NextResponse.json({ error: "At least one article is required" }, { status: 400 });
  }

  // Validate each article has required fields
  for (const [i, article] of articles.entries()) {
    if (!article.title || !article.slug || !article.content || !article.topicId) {
      return NextResponse.json(
        { error: `Article [${i}] missing required fields: title, slug, content, topicId` },
        { status: 400 }
      );
    }

    if (!/^[a-z0-9-]+$/.test(article.slug)) {
      return NextResponse.json(
        { error: `Article [${i}] slug must be lowercase alphanumeric with hyphens only` },
        { status: 400 }
      );
    }
  }

  // Verify all topicIds exist
  const topicIds = [...new Set(articles.map((a) => a.topicId))];
  const topics = await prisma.topic.findMany({
    where: { id: { in: topicIds } },
    select: { id: true, name: true, slug: true },
  });

  const topicMap = new Map(topics.map((t) => [t.id, t]));
  for (const topicId of topicIds) {
    if (!topicMap.has(topicId)) {
      return NextResponse.json({ error: `Topic not found: ${topicId}` }, { status: 404 });
    }
  }

  // --- Create articles ---
  const sourceUrl = source.type === "url" ? source.url : null;
  const createdArticles: { id: string; title: string; slug: string; topic: string }[] = [];
  let totalTagsApplied = 0;

  // Validate content sizes before entering transaction — throws are not caught inside $transaction
  for (const article of articles) {
    if (new TextEncoder().encode(article.content).length > MAX_ARTICLE_CONTENT_SIZE) {
      return NextResponse.json(
        { error: `Article [${articles.indexOf(article)}] content exceeds ${MAX_ARTICLE_CONTENT_SIZE} bytes` },
        { status: 400 }
      );
    }
  }

  // Use a transaction to keep everything consistent
  const result = await prisma.$transaction(async (tx) => {
    for (const article of articles) {
      // Check slug uniqueness within topic
      const existing = await tx.article.findUnique({
        where: { topicId_slug: { topicId: article.topicId, slug: article.slug } },
      });

      if (existing) {
        // Skip — don't overwrite in ingest. Agent should use PATCH for updates.
        // Log a warning but continue with other articles.
        continue;
      }

      // Merge article tags + global tags, deduplicate
      const articleTags = [...(article.tags ?? []), ...(globalTags ?? [])];
      const uniqueTags = [...new Set(articleTags.map((t) => t.trim().toLowerCase()))].filter(Boolean);

      // Build tag connections (upsert tags)
      const tagConnections = await Promise.all(
        uniqueTags.map(async (tagName) => {
          const originalName = articleTags.find(
            (t) => t.trim().toLowerCase() === tagName
          ) || tagName;
          const tagSlug = tagName.replace(/\s+/g, "-");
          const tag = await tx.tag.upsert({
            where: { slug: tagSlug },
            create: { name: originalName.trim(), slug: tagSlug },
            update: {},
          });
          return { tagId: tag.id };
        })
      );

      totalTagsApplied += tagConnections.length;

      const topic = topicMap.get(article.topicId)!;

      // Build excerpt: use provided, or derive from content
      const excerpt =
        article.excerpt ||
        article.content.slice(0, 200).replace(/[#*`_]/g, "").trim();

      const created = await tx.article.create({
        data: {
          title: article.title,
          slug: article.slug,
          content: article.content,
          excerpt,
          authorId: userId,
          // article.authorName is accepted but sanitized — strip HTML, cap length
          authorName: (article.authorName ?? "")
            .replace(/<[^>]*>/g, "")
            .trim()
            .slice(0, MAX_AUTHOR_NAME_LENGTH) || sanitizedAuthorName,
          topicId: article.topicId,
          sourceUrl: article.sourceUrl || sourceUrl,
          sourceType: source.type,
          confidence: article.confidence || null,
          status: article.status || "published",
          tags: { create: tagConnections },
          revisions: {
            create: {
              authorId: userId,
              title: article.title,
              content: article.content,
            },
          },
        },
        select: { id: true },
      });

      createdArticles.push({
        id: created.id,
        title: article.title,
        slug: article.slug,
        topic: topic.name,
      });

      // Create ArticleRelation records for related articles
      if (article.relatedArticleIds && article.relatedArticleIds.length > 0) {
        await tx.articleRelation.createMany({
          data: article.relatedArticleIds
            .filter((targetId: string) => targetId !== created.id)
            .map((targetId: string) => ({ sourceId: created.id, targetId })),
          skipDuplicates: true,
        });
      }
    }

    // --- Log the ingest ---
    const logEntry = await tx.activityLog.create({
      data: {
        type: "ingest",
        title: `Ingested "${source.title}" — ${createdArticles.length} articles created`,
        sourceUrl,
        authorName: sanitizedAuthorName,
        details: {
          sourceTitle: source.title,
          sourceType: source.type,
          articlesCreated: createdArticles.length,
          articlesRequested: articles.length,
          articleIds: createdArticles.map((a) => a.id),
          tagsApplied: totalTagsApplied,
        },
      },
    });

    return { logId: logEntry.id };
  });

  return NextResponse.json(
    {
      success: true,
      ingestId: result.logId,
      created: createdArticles.length,
      skipped: articles.length - createdArticles.length,
      articles: createdArticles,
      tagsApplied: totalTagsApplied,
    },
    { status: 201 }
  );
}
