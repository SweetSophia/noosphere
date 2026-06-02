import { NextRequest, NextResponse } from "next/server";
import { Permissions } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission, buildScopeFilter } from "@/lib/api/auth";
import { resolveRestrictedTagsForCaller } from "@/lib/api/restricted-scopes";
import { buildTagConnections, countSearchArticles, searchArticleIds } from "@/lib/wiki";
import { detectSecretInInputs } from "@/lib/memory/api/save";
import { invalidateSearchCache } from "@/lib/cache/search-cache";
import {
  filterAccessibleRelatedTargets,
  isAccessibleRelatedArticle,
} from "@/lib/articles/relations";
import {
  ARTICLE_LIMITS,
  QUERY_LIMITS,
  deriveExcerpt,
  isValidConfidence,
  isValidStatus,
  sanitizeAuthorName,
  validateSearchQuery,
  validateSlug,
} from "@/lib/validation";
import { parsePagination } from "@/lib/pagination";
import { rateLimit } from "@/lib/rate-limit";

// GET /api/articles — List articles (with filters)
// Auth: API key (READ/WRITE/ADMIN) or session (human)
export async function GET(request: NextRequest) {
  const rl = await rateLimit(request, { windowMs: 60_000, maxRequests: 60, keyPrefix: "articles-get" });
  if (!rl.allowed) return rl.response;

  const auth = await requirePermission(request, [Permissions.READ]);
  if (!auth.success) {
    return auth.response;
  }

  const { searchParams } = new URL(request.url);
  const rawTopicSlug = searchParams.get("topic");
  const rawTag = searchParams.get("tag");
  const rawQ = searchParams.get("q");

  // Validate query string length
  const qValidation = validateSearchQuery(rawQ);
  if (!qValidation.ok) {
    return NextResponse.json({ error: qValidation.error }, { status: 400 });
  }
  const q = qValidation.query;

  // Validate topic and tag slug length (prevent DoS via oversized query params)
  if (rawTopicSlug && rawTopicSlug.length > QUERY_LIMITS.maxSlugLength) {
    return NextResponse.json({ error: "topic parameter too long" }, { status: 400 });
  }
  if (rawTag && rawTag.length > QUERY_LIMITS.maxSlugLength) {
    return NextResponse.json({ error: "tag parameter too long" }, { status: 400 });
  }

  const topicSlug = rawTopicSlug;
  const tag = rawTag;
  const { page, limit, offset } = parsePagination(searchParams);
  const status = searchParams.get("status");
  const confidence = searchParams.get("confidence");

  // Validate status/confidence against allow-lists
  if (status && !isValidStatus(status)) {
    return NextResponse.json({ error: "Invalid status filter" }, { status: 400 });
  }
  if (confidence && !isValidConfidence(confidence)) {
    return NextResponse.json({ error: "Invalid confidence filter" }, { status: 400 });
  }

  try {
    // Build scope-filtered where clause — restricts articles based on key scopes
    const where = buildScopeFilter(auth.auth.allowedScopes, { deletedAt: null });

    if (topicSlug) {
      where.topic = { slug: topicSlug };
    }

    if (tag) {
      where.tags = { some: { tag: { slug: tag } } };
    }

    if (status) {
      where.status = status;
    }

    if (confidence) {
      where.confidence = confidence;
    }

    const articleIds = q
      ? await searchArticleIds(q, {
        topicSlug: topicSlug ?? undefined,
        tagSlug: tag ?? undefined,
        status: status ?? undefined,
        confidence: confidence ?? undefined,
        allowedScopes: auth.auth.allowedScopes,
        limit,
        offset,
      })
      : [];

    const [articles, total] = await Promise.all([
      q
        ? articleIds.length
          ? prisma.article.findMany({
            where: { id: { in: articleIds } },
            include: {
              topic: true,
              tags: { include: { tag: true } },
              author: { select: { id: true, name: true } },
              relatedTo: {
                include: {
                  target: { select: { id: true, title: true, slug: true, topic: true, restrictedTags: true, deletedAt: true } },
                },
              },
            },
          }).then((rows) => {
            const rowsById = new Map(rows.map((row) => [row.id, row]));
            return articleIds
              .map((id) => rowsById.get(id))
              .filter((row): row is (typeof rows)[number] => row !== undefined);
          })
          : Promise.resolve([])
        : prisma.article.findMany({
          where,
          include: {
            topic: true,
            tags: { include: { tag: true } },
            author: { select: { id: true, name: true } },
            relatedTo: {
              include: {
                target: { select: { id: true, title: true, slug: true, topic: true, restrictedTags: true, deletedAt: true } },
              },
            },
          },
          skip: offset,
          take: limit,
          orderBy: { updatedAt: "desc" },
        }),
      q
        ? countSearchArticles(q, {
          topicSlug: topicSlug ?? undefined,
          tagSlug: tag ?? undefined,
          status: status ?? undefined,
          confidence: confidence ?? undefined,
          allowedScopes: auth.auth.allowedScopes,
        })
        : prisma.article.count({ where }),
    ]);

    const formatted = articles.map((a) => ({
      id: a.id,
      title: a.title,
      slug: a.slug,
      excerpt: a.excerpt,
      topic: { id: a.topic.id, name: a.topic.name, slug: a.topic.slug },
      tags: a.tags.map((t) => ({ id: t.tag.id, name: t.tag.name, slug: t.tag.slug })),
      author: a.author ? { id: a.author.id, name: a.author.name } : { name: a.authorName },
      confidence: a.confidence,
      status: a.status,
      restrictedTags: a.restrictedTags ?? [],
      lastReviewed: a.lastReviewed,
      relatedArticles: a.relatedTo
        .filter((r) => isAccessibleRelatedArticle(r, auth.auth.allowedScopes))
        .map((r) => ({
          id: r.target.id,
          title: r.target.title,
          slug: r.target.slug,
          topicSlug: r.target.topic.slug,
        })),
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    }));

    return NextResponse.json({
      articles: formatted,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("[GET /api/articles]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/articles — Create article
// Auth: API key (WRITE/ADMIN) or session (EDITOR/ADMIN)
export async function POST(request: NextRequest) {
  const rl = await rateLimit(request, { windowMs: 60_000, maxRequests: 30, keyPrefix: "articles-post" });
  if (!rl.allowed) return rl.response;

  const auth = await requirePermission(request, [Permissions.WRITE]);
  if (!auth.success) {
    return auth.response;
  }

  try {
    const body = await request.json();
    const { title, slug, content, topicId, tags, excerpt, authorName, confidence, status, relatedArticleIds, restrictedTags } = body;

    // Validate relatedArticleIds is an array of valid CUIDs
    if (relatedArticleIds !== undefined) {
      if (!Array.isArray(relatedArticleIds) || !(relatedArticleIds as unknown[]).every((id) => typeof id === "string" && id.length > 0)) {
        return NextResponse.json(
          { error: "relatedArticleIds must be an array of non-empty strings" },
          { status: 400 }
        );
      }
    }

    // Validate required fields are non-empty strings
    if (
      typeof title !== "string" || !title.trim() ||
      typeof slug !== "string" || !slug.trim() ||
      typeof content !== "string" || !content.trim() ||
      typeof topicId !== "string"
    ) {
      return NextResponse.json(
        { error: "Missing required fields: title, slug, content, topicId (must be non-empty strings)" },
        { status: 400 }
      );
    }

    // Validate excerpt type (must be string if provided)
    if (excerpt != null && typeof excerpt !== "string") {
      return NextResponse.json(
        { error: "Excerpt must be a string when provided" },
        { status: 400 }
      );
    }

    // Security: Validate content size using byte length for accurate 1MB limit
    if (new TextEncoder().encode(content).length > ARTICLE_LIMITS.maxContentSize) {
      return NextResponse.json(
        { error: `Content exceeds maximum size of ${ARTICLE_LIMITS.maxContentSize} bytes` },
        { status: 400 }
      );
    }

    // Security: Validate title length (character count, not bytes)
    if (title.length > ARTICLE_LIMITS.maxTitleLength) {
      return NextResponse.json(
        { error: `Title exceeds maximum length of ${ARTICLE_LIMITS.maxTitleLength} characters` },
        { status: 400 }
      );
    }

    // Security: Validate excerpt length (character count, not bytes)
    if (excerpt && excerpt.length > ARTICLE_LIMITS.maxExcerptLength) {
      return NextResponse.json(
        { error: `Excerpt exceeds maximum length of ${ARTICLE_LIMITS.maxExcerptLength} characters` },
        { status: 400 }
      );
    }

    if (status && !isValidStatus(status)) {
      return NextResponse.json(
        { error: "status must be one of: draft, reviewed, published" },
        { status: 400 }
      );
    }

    if (confidence && !isValidConfidence(confidence)) {
      return NextResponse.json(
        { error: "confidence must be one of: low, medium, high" },
        { status: 400 }
      );
    }

    const secretError = detectSecretInInputs([
      { field: "title", value: title },
      { field: "content", value: content },
      { field: "excerpt", value: excerpt },
      { field: "authorName", value: authorName },
      ...(Array.isArray(tags)
        ? tags.map((value) => ({ field: "tags", value: typeof value === "string" ? value : undefined }))
        : []),
    ]);
    if (secretError) {
      return NextResponse.json({ error: secretError.error }, { status: secretError.status });
    }

    const restrictedTagsResult = await resolveRestrictedTagsForCaller(
      restrictedTags,
      auth.auth.allowedScopes,
    );
    if (!restrictedTagsResult.ok) {
      return NextResponse.json(
        { error: restrictedTagsResult.error },
        { status: restrictedTagsResult.status },
      );
    }

    // Validate slug format
    const slugValidation = validateSlug(slug);
    if (!slugValidation.ok) {
      return NextResponse.json({ error: slugValidation.error }, { status: 400 });
    }

    // Check topic exists
    const topic = await prisma.topic.findUnique({ where: { id: topicId } });
    if (!topic) {
      return NextResponse.json({ error: "Topic not found" }, { status: 404 });
    }

    // Check slug uniqueness within topic
    // Validate tags is an array of strings
    if (tags !== undefined && (!Array.isArray(tags) || !(tags as unknown[]).every((t) => typeof t === "string"))) {
      return NextResponse.json(
        { error: "tags must be an array of strings" },
        { status: 400 }
      );
    }

    // Handle tags: normalize, dedupe, then upsert using shared helper
    const tagConnections = await buildTagConnections(tags ?? []);

    const article = await prisma.$transaction(async (tx) => {
      // Race-condition fix: check slug uniqueness INSIDE the transaction so the
      // unique constraint violation is impossible to trigger from outside.
      // If a concurrent request creates the same slug between our check and
      // insert, Prisma's unique constraint catches it — we convert that to 409.
      const existing = await tx.article.findUnique({
        where: { topicId_slug: { topicId, slug: slugValidation.slug } },
      });
      if (existing) {
        throw new ConflictError("Article with this slug already exists in this topic");
      }

      const created = await tx.article.create({
        data: {
          title,
          slug: slugValidation.slug,
          content,
          excerpt: excerpt || deriveExcerpt(content),
          topicId,
          authorId: auth.auth.userId ?? null,
          authorName: sanitizeAuthorName(authorName) || (auth.auth.name ?? null),
          tags: { create: tagConnections },
          confidence: confidence || null,
          status: status || "published",
          restrictedTags: restrictedTagsResult.value,
          revisions: {
            create: {
              authorId: auth.auth.userId ?? null,
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

      // Filter against the caller's scopes (and skip non-existent /
      // soft-deleted targets) so a scoped key cannot link an unrestricted
      // source to a restricted target the caller cannot see — which would
      // otherwise leak the target's title/slug/topic in the related-articles
      // panel of the source's GET response.
      if (relatedArticleIds && relatedArticleIds.length > 0) {
        const accessibleTargetIds = await filterAccessibleRelatedTargets(
          tx,
          relatedArticleIds.filter((id: string) => id !== created.id),
          auth.auth.allowedScopes,
        );

        if (accessibleTargetIds.length > 0) {
          await tx.articleRelation.createMany({
            data: accessibleTargetIds.map((targetId) => ({
              sourceId: created.id,
              targetId,
            })),
            skipDuplicates: true,
          });
        }
      }

      return created;
    });

    await invalidateSearchCache();

    return NextResponse.json(
      {
        id: article.id,
        title: article.title,
        slug: article.slug,
        topic: article.topic,
        tags: article.tags.map((t: { tag: { id: string; name: string; slug: string } }) => t.tag),
        restrictedTags: article.restrictedTags,
        createdAt: article.createdAt,
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof ConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // Handle Prisma unique constraint violation from concurrent race condition
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { error: "Article with this slug already exists in this topic" },
        { status: 409 }
      );
    }
    console.error("[POST /api/articles]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}
