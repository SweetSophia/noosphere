import { NextRequest, NextResponse } from "next/server";
import { Permissions } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/api/auth";
import {
  DEFAULT_JSON_BODY_MAX_BYTES,
  getJsonBodyError,
  readBoundedJsonObject,
} from "@/lib/api/body";
import { apiError } from "@/lib/api/errors";
import {
  ARTICLE_LIMITS,
  deriveExcerpt,
  isValidConfidence,
  isValidStatus,
  sanitizeAuthorName,
  validateSlug,
} from "@/lib/validation";
import { rateLimit } from "@/lib/rate-limit";
import { invalidateSearchCache } from "@/lib/cache/search-cache";
import { slugify } from "@/lib/wiki";

const ANSWER_SLUG_MAX_LENGTH = 80;
const ANSWER_JSON_BODY_MAX_BYTES =
  ARTICLE_LIMITS.maxContentSize + DEFAULT_JSON_BODY_MAX_BYTES;

// POST /api/answer — Save a synthesized answer as a new wiki article
// Auth: API key (WRITE/ADMIN) or session (EDITOR/ADMIN)
//
// A frictionless wrapper around article creation for the "answer-to-page" flow:
// after a wiki query returns a good synthesis, file it as a new article.
//
// Body:
//   title          — article title
//   content        — synthesized markdown content
//   topicId        — where to file this
//   excerpt?       — short summary (auto-derived if omitted)
//   tags?          — tag names array
//   sourceQuery?   — the original query that produced this answer
//   confidence?    — low/medium/high
//   status?        — draft/reviewed/published (default: published)
//   authorName?    — override author name
//
// Response:
//   { article: {id, title, slug, topic, tags}, answerId }

export async function POST(request: NextRequest) {
  const rl = await rateLimit(request, { windowMs: 60_000, maxRequests: 30, keyPrefix: "answer" });
  if (!rl.allowed) return rl.response;

  const auth = await requirePermission(request, [Permissions.WRITE]);
  if (!auth.success) {
    return auth.response;
  }

  let body: {
    title: string;
    content: string;
    topicId: string;
    excerpt?: string;
    tags?: string[];
    sourceQuery?: string;
    confidence?: string;
    status?: string;
    authorName?: string;
  };

  try {
    body = await readBoundedJsonObject<typeof body>(
      request,
      ANSWER_JSON_BODY_MAX_BYTES,
    );
  } catch (error) {
    const bodyError = getJsonBodyError(error);
    return apiError(bodyError.message, bodyError.status);
  }

  const { title, content, topicId, excerpt, tags, sourceQuery, confidence, status, authorName: rawAuthorName } = body;
  // Sanitize authorName from body to prevent HTML injection / name spoofing
  const authorName = sanitizeAuthorName(rawAuthorName) || auth.auth.name || "Unknown";
  const userId = auth.auth.userId ?? null;

  // Validate required fields
  if (!title || !content || !topicId) {
    return NextResponse.json(
      { error: "title, content, and topicId are required" },
      { status: 400 }
    );
  }

  // Validate enums
  if (status && !isValidStatus(status)) {
    return NextResponse.json({ error: "status must be draft/reviewed/published" }, { status: 400 });
  }
  if (confidence && !isValidConfidence(confidence)) {
    return NextResponse.json({ error: "confidence must be low/medium/high" }, { status: 400 });
  }

  // Verify topic exists
  const topic = await prisma.topic.findUnique({ where: { id: topicId } });
  if (!topic) {
    return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  }

  // Derive slug from title
  const slug = validateSlug(slugify(title).slice(0, ANSWER_SLUG_MAX_LENGTH));
  if (!slug.ok) {
    return NextResponse.json({ error: slug.error }, { status: 400 });
  }

  // Check slug uniqueness
  const existing = await prisma.article.findUnique({
    where: { topicId_slug: { topicId, slug: slug.slug } },
  });
  if (existing) {
    return NextResponse.json(
      { error: `Article with slug "${slug.slug}" already exists in this topic`, existingArticleId: existing.id },
      { status: 409 }
    );
  }

  // Build tag connections
  const tagConnections = tags?.length
    ? await Promise.all(
        tags.map(async (tagName: string) => {
          const tagSlug = tagName.toLowerCase().replace(/\s+/g, "-");
          const tag = await prisma.tag.upsert({
            where: { slug: tagSlug },
            create: { name: tagName, slug: tagSlug },
            update: {},
          });
          return { tagId: tag.id };
        })
      )
    : [];

  // Derive excerpt if not provided
  const derivedExcerpt = excerpt || deriveExcerpt(content, 200);

  const article = await prisma.$transaction(async (tx) => {
    const created = await tx.article.create({
      data: {
        title,
        slug: slug.slug,
        content,
        excerpt: derivedExcerpt,
        topicId,
        authorId: userId,
        authorName,
        confidence: confidence || null,
        status: status || "published",
        sourceType: sourceQuery ? "query" : "manual",
        sourceUrl: sourceQuery || null,
        tags: { create: tagConnections },
        revisions: {
          create: {
            authorId: userId,
            title,
            content,
          },
        },
      },
      include: {
        topic: true,
        tags: { include: { tag: true } },
      },
    });

    // Log the answer-to-page event
    await tx.activityLog.create({
      data: {
        type: "answer_saved",
        title: `Answer saved as "${title}"`,
        authorName,
        details: {
          articleId: created.id,
          topic: topic.name,
          sourceQuery,
          tagCount: tagConnections.length,
          confidence,
          status: status || "published",
        },
      },
    });

    return created;
  });

  await invalidateSearchCache();

  return NextResponse.json(
    {
      success: true,
      article: {
        id: article.id,
        title: article.title,
        slug: article.slug,
        topic: { id: article.topic.id, name: article.topic.name, slug: article.topic.slug },
        tags: article.tags.map((t) => ({ id: t.tag.id, name: t.tag.name, slug: t.tag.slug })),
        confidence: article.confidence,
        status: article.status,
        url: `/wiki/${article.topic.slug}/${article.slug}`,
      },
    },
    { status: 201 }
  );
}
