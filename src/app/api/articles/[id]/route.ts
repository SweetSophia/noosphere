import { NextRequest, NextResponse } from "next/server";
import { Permissions } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission, canAccessScopes } from "@/lib/api/auth";
import {
  DEFAULT_JSON_BODY_MAX_BYTES,
  getJsonBodyError,
  readBoundedJsonObject,
} from "@/lib/api/body";
import {
  buildArticleStripObservation,
  sanitizeArticleContent,
  sanitizeArticleExcerpt,
} from "@/lib/api/article-content";
import { buildTagConnections } from "@/lib/wiki";
import {
  syncArticleRelations,
  filterAccessibleRelatedTargets,
  filterVisibleRelatedArticleRows,
} from "@/lib/articles/relations";
import {
  ARTICLE_LIMITS,
  deriveExcerpt,
  isValidConfidence,
  isValidStatus,
  validateSlug,
} from "@/lib/validation";
import { invalidateSearchCache } from "@/lib/cache/search-cache";
import { rateLimit } from "@/lib/rate-limit";
import { resolvePatchRestrictedTags } from "@/lib/api/restricted-scopes";
import { detectSecretInInputs } from "@/lib/memory/api/save";

const ARTICLE_JSON_BODY_MAX_BYTES =
  ARTICLE_LIMITS.maxContentSize + DEFAULT_JSON_BODY_MAX_BYTES;

// PATCH /api/articles/[id] — Update article
// Auth: API key (WRITE/ADMIN) or session (EDITOR/ADMIN)
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const rl = await rateLimit(request, { windowMs: 60_000, maxRequests: 30, keyPrefix: "articles-patch" });
  if (!rl.allowed) return rl.response;

  const { id } = await params;

  const auth = await requirePermission(request, [Permissions.WRITE]);
  if (!auth.success) {
    return auth.response;
  }

  try {
    // Check article exists
    const existing = await prisma.article.findUnique({
      where: { id },
      include: { tags: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Article not found" }, { status: 404 });
    }
    if (existing.deletedAt) {
      return NextResponse.json({ error: "Article not found" }, { status: 404 });
    }

    // Scope check: article's restrictedTags must have at least one match with key's allowedScopes
    if (!canAccessScopes(existing.restrictedTags ?? [], auth.auth.allowedScopes)) {
      return NextResponse.json({ error: "Article not found" }, { status: 404 });
    }

    let body: {
      title?: string;
      slug?: string;
      content?: string;
      excerpt?: string | null;
      topicId?: string;
      tags?: string[];
      confidence?: string;
      status?: string;
      relatedArticleIds?: string[];
      lastReviewed?: string | number | null;
      restrictedTags?: unknown;
    };
    try {
      body = await readBoundedJsonObject<typeof body>(
        request,
        ARTICLE_JSON_BODY_MAX_BYTES,
      );
    } catch (error) {
      const bodyError = getJsonBodyError(error);
      return NextResponse.json(
        { error: bodyError.message },
        { status: bodyError.status },
      );
    }
    const {
      title,
      slug,
      content,
      excerpt,
      topicId,
      tags,
      confidence,
      status,
      relatedArticleIds,
      lastReviewed,
      restrictedTags,
    } = body;

    // Build update data — all fields optional
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    let sanitizedContent: string | undefined;
    let sanitizedExcerpt: string | undefined;
    let contentStrippedBlocks: string[] = [];
    let excerptStrippedBlocks: string[] = [];

    // title
    if (title !== undefined) {
      if (typeof title !== "string" || !title.trim()) {
        return NextResponse.json({ error: "title must be a non-empty string" }, { status: 400 });
      }
      if (title.length > ARTICLE_LIMITS.maxTitleLength) {
        return NextResponse.json({ error: `title exceeds maximum length of ${ARTICLE_LIMITS.maxTitleLength} characters` }, { status: 400 });
      }
      updateData.title = title.trim();
    }

    // slug
    if (slug !== undefined) {
      if (typeof slug !== "string" || !slug.trim()) {
        return NextResponse.json({ error: "slug must be a non-empty string" }, { status: 400 });
      }
      const slugValidation = validateSlug(slug);
      if (!slugValidation.ok) {
        return NextResponse.json({ error: slugValidation.error }, { status: 400 });
      }
      // Check slug uniqueness within same topic (if changing topicId too, checked later)
      const targetTopicId = topicId ?? existing.topicId;
      const slugConflict = await prisma.article.findFirst({
        where: {
          id: { not: id },
          topicId: targetTopicId,
          slug: slugValidation.slug,
        },
      });
      if (slugConflict) {
        return NextResponse.json({ error: "Article with this slug already exists in this topic" }, { status: 409 });
      }
      updateData.slug = slugValidation.slug;
    }

    // content
    if (content !== undefined) {
      if (typeof content !== "string") {
        return NextResponse.json({ error: "content must be a string" }, { status: 400 });
      }
      const encoded = new TextEncoder().encode(content);
      if (encoded.length > ARTICLE_LIMITS.maxContentSize) {
        return NextResponse.json({ error: `content exceeds maximum size of ${ARTICLE_LIMITS.maxContentSize} bytes` }, { status: 400 });
      }
      const contentSanitization = sanitizeArticleContent(content);
      if (!contentSanitization.ok) {
        return NextResponse.json(
          { error: contentSanitization.error },
          { status: contentSanitization.status },
        );
      }

      sanitizedContent = contentSanitization.content;
      contentStrippedBlocks = contentSanitization.strippedBlocks;
      updateData.content = sanitizedContent;

      // Auto-update excerpt if content changed and no explicit excerpt provided
      if (excerpt === undefined) {
        updateData.excerpt = deriveExcerpt(sanitizedContent);
      }
    }

    // excerpt
    if (excerpt !== undefined) {
      if (excerpt !== null && typeof excerpt !== "string") {
        return NextResponse.json({ error: "excerpt must be a string or null" }, { status: 400 });
      }
      if (excerpt && excerpt.length > ARTICLE_LIMITS.maxExcerptLength) {
        return NextResponse.json({ error: `excerpt exceeds maximum length of ${ARTICLE_LIMITS.maxExcerptLength} characters` }, { status: 400 });
      }
      if (excerpt === null) {
        sanitizedExcerpt = "";
      } else {
        const excerptSanitization = sanitizeArticleExcerpt(excerpt);
        if (!excerptSanitization.ok) {
          return NextResponse.json(
            { error: excerptSanitization.error },
            { status: excerptSanitization.status },
          );
        }
        sanitizedExcerpt = excerptSanitization.excerpt;
        excerptStrippedBlocks = excerptSanitization.strippedBlocks;
      }
      updateData.excerpt = sanitizedExcerpt;
    }

    // topicId
    if (topicId !== undefined) {
      if (typeof topicId !== "string") {
        return NextResponse.json({ error: "topicId must be a string" }, { status: 400 });
      }
      const topic = await prisma.topic.findUnique({ where: { id: topicId } });
      if (!topic) {
        return NextResponse.json({ error: "Topic not found" }, { status: 404 });
      }
      updateData.topicId = topicId;
    }

    // status
    if (status !== undefined) {
      if (!isValidStatus(status)) {
        return NextResponse.json({ error: "status must be one of: draft, reviewed, published" }, { status: 400 });
      }
      updateData.status = status;
    }

    // confidence
    if (confidence !== undefined) {
      if (!isValidConfidence(confidence)) {
        return NextResponse.json({ error: "confidence must be one of: low, medium, high" }, { status: 400 });
      }
      updateData.confidence = confidence;
    }

    // relatedArticleIds — handled separately (not a direct field, uses ArticleRelation table)
    if (relatedArticleIds !== undefined) {
      if (!Array.isArray(relatedArticleIds) || !(relatedArticleIds as unknown[]).every((id) => typeof id === "string" && id.length > 0)) {
        return NextResponse.json({ error: "relatedArticleIds must be an array of non-empty strings" }, { status: 400 });
      }
    }

    // lastReviewed
    if (lastReviewed !== undefined) {
      if (lastReviewed !== null && (typeof lastReviewed !== "string" && typeof lastReviewed !== "number")) {
        return NextResponse.json({ error: "lastReviewed must be an ISO timestamp, Unix timestamp, or null" }, { status: 400 });
      }
      updateData.lastReviewed = lastReviewed ? new Date(lastReviewed) : null;
    }

    // restrictedTags — validate via the shared scope helper (issue #182).
    // PATCH semantics: an explicit [] declassifies and never auto-inherits the
    // caller's scopes; only present tags are type/existence/membership-checked.
    if (restrictedTags !== undefined) {
      const restrictedTagsResult = await resolvePatchRestrictedTags(
        restrictedTags,
        auth.auth.allowedScopes,
      );
      if (!restrictedTagsResult.ok) {
        return NextResponse.json(
          { error: restrictedTagsResult.error },
          { status: restrictedTagsResult.status },
        );
      }
      updateData.restrictedTags = restrictedTagsResult.value;
    }

    // tags — validate early if provided
    if (tags !== undefined) {
      if (!Array.isArray(tags) || !(tags as unknown[]).every((t) => typeof t === "string")) {
        return NextResponse.json({ error: "tags must be an array of strings" }, { status: 400 });
      }
    }

    const secretError = detectSecretInInputs([
      { field: "title", value: title },
      { field: "content", value: sanitizedContent },
      { field: "excerpt", value: sanitizedExcerpt },
      ...(Array.isArray(tags)
        ? tags.map((value) => ({ field: "tags", value: typeof value === "string" ? value : undefined }))
        : []),
    ]);
    if (secretError) {
      return NextResponse.json({ error: secretError.error }, { status: secretError.status });
    }

    // Build tag connections if tags are being updated
    let newTagConnections: { tagId: string }[] = [];
    if (tags !== undefined) {
      newTagConnections = await buildTagConnections(tags as string[]);
    }

    // Create revision if content or title changed
    const titleChanged = title !== undefined && title !== existing.title;
    const contentChanged =
      sanitizedContent !== undefined && sanitizedContent !== existing.content;

    if (titleChanged || contentChanged) {
      updateData.revisions = {
        create: {
          authorId: auth.auth.userId ?? null,
          title: (title ?? existing.title) as string,
          content: (sanitizedContent ?? existing.content) as string,
        },
      };
    }

    const stripObservation = buildArticleStripObservation([
      { field: "content", strippedBlocks: contentStrippedBlocks },
      { field: "excerpt", strippedBlocks: excerptStrippedBlocks },
    ]);

    // Execute update in transaction: article update + tag reconnect + relation sync
    const updatedArticle = await prisma.$transaction(async (tx) => {
      // Update article fields
      await tx.article.update({
        where: { id },
        data: updateData,
      });

      if (stripObservation) {
        await tx.activityLog.create({
          data: {
            type: "article_content_stripped",
            title: `Injected memory stripped from article update: ${String(updateData.title ?? existing.title)}`,
            authorName: auth.auth.name ?? "API",
            details: {
              route: "PATCH /api/articles/[id]",
              kind: "single",
              articleId: id,
              topicId: (updateData.topicId as string | undefined) ?? existing.topicId,
              slug: (updateData.slug as string | undefined) ?? existing.slug,
              ...stripObservation,
            },
          },
        });
      }

      // Reconnect tags if changed
      if (tags !== undefined) {
        await tx.articleTag.deleteMany({ where: { articleId: id } });
        if (newTagConnections.length > 0) {
          await tx.articleTag.createMany({
            data: newTagConnections.map((tc) => ({ articleId: id, tagId: tc.tagId })),
          });
        }
      }

      // Filter against the caller's scopes so a scoped key cannot replace
      // existing relations with links to restricted articles it cannot see.
      const safeRelatedArticleIds =
        relatedArticleIds === undefined
          ? undefined
          : await filterAccessibleRelatedTargets(
              tx,
              relatedArticleIds,
              auth.auth.allowedScopes,
            );

      await syncArticleRelations(tx, id, safeRelatedArticleIds);

      // Return updated article with relations
      return tx.article.findUnique({
        where: { id },
        include: {
          topic: true,
          tags: { include: { tag: true } },
          relatedTo: {
            include: {
              target: { select: { id: true, title: true, slug: true, topic: true, restrictedTags: true, deletedAt: true } },
            },
          },
        },
      });
    });

    await invalidateSearchCache();

    return NextResponse.json({
      id: updatedArticle!.id,
      title: updatedArticle!.title,
      slug: updatedArticle!.slug,
      excerpt: updatedArticle!.excerpt,
      topic: { id: updatedArticle!.topic.id, name: updatedArticle!.topic.name, slug: updatedArticle!.topic.slug },
      tags: updatedArticle!.tags.map((t) => ({ id: t.tag.id, name: t.tag.name, slug: t.tag.slug })),
      confidence: updatedArticle!.confidence,
      status: updatedArticle!.status,
      restrictedTags: updatedArticle!.restrictedTags ?? [],
      lastReviewed: updatedArticle!.lastReviewed,
      relatedArticles: filterVisibleRelatedArticleRows(updatedArticle!.relatedTo, auth.auth.allowedScopes)
        .map((r) => ({
          id: r.target.id,
          title: r.target.title,
          slug: r.target.slug,
          topicSlug: r.target.topic.slug,
        })),
      createdAt: updatedArticle!.createdAt,
      updatedAt: updatedArticle!.updatedAt,
    });
  } catch (error) {
    console.error("[PATCH /api/articles/[id]]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/articles/[id] — Soft-delete article
// Auth: API key (ADMIN) or session (ADMIN)
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const rl = await rateLimit(request, { windowMs: 60_000, maxRequests: 30, keyPrefix: "articles-delete" });
  if (!rl.allowed) return rl.response;

  const { id } = await params;

  const auth = await requirePermission(request, [Permissions.ADMIN]);
  if (!auth.success) {
    return auth.response;
  }

  // Fetch to check scope before deleting
  const existing = await prisma.article.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) {
    return NextResponse.json({ error: "Article not found" }, { status: 404 });
  }
  if (!canAccessScopes(existing.restrictedTags ?? [], auth.auth.allowedScopes)) {
    return NextResponse.json({ error: "Article not found" }, { status: 404 });
  }

  const now = new Date();

  // Atomic soft-delete: only succeeds if article exists AND is not already deleted.
  // This eliminates the read-then-write race condition.
  const count = await prisma.article.updateMany({
    where: { id, deletedAt: null },
    data: { deletedAt: now, updatedAt: now },
  });

  if (count.count === 0) {
    // Article was already deleted — safe to return 204 idempotently
    return new NextResponse(null, { status: 204 });
  }

  await invalidateSearchCache();

  // Log the deletion for audit trail
  const authorName = auth.auth.name ?? "API";
  try {
    await prisma.activityLog.create({
      data: {
        type: "delete",
        title: `Article deleted — ${id}`,
        authorName,
      },
    });
  } catch {
    // Log failures are non-fatal; don't fail the delete itself
  }

  return new NextResponse(null, { status: 204 });
}
