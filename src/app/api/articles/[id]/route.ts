import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiKey } from "@/lib/api/keys";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { buildTagConnections } from "@/lib/wiki";

// PATCH /api/articles/[id] — Update article
// Auth: API key (WRITE/ADMIN) or session (EDITOR/ADMIN)
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const apiAuth = await requireApiKey(request);
  const session = await getServerSession(authOptions);

  if (!apiAuth.authorized && !session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Check permissions
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

    const body = await request.json();
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
    } = body;

    // Build update data — all fields optional
    const updateData: Record<string, unknown> = { updatedAt: new Date() };

    // title
    if (title !== undefined) {
      if (typeof title !== "string" || !title.trim()) {
        return NextResponse.json({ error: "title must be a non-empty string" }, { status: 400 });
      }
      if (title.length > 200) {
        return NextResponse.json({ error: "title exceeds maximum length of 200 characters" }, { status: 400 });
      }
      updateData.title = title.trim();
    }

    // slug
    if (slug !== undefined) {
      if (typeof slug !== "string" || !slug.trim()) {
        return NextResponse.json({ error: "slug must be a non-empty string" }, { status: 400 });
      }
      if (!/^[a-z0-9-]+$/.test(slug)) {
        return NextResponse.json({ error: "slug must be lowercase alphanumeric with hyphens only" }, { status: 400 });
      }
      // Check slug uniqueness within same topic (if changing topicId too, checked later)
      const targetTopicId = topicId ?? existing.topicId;
      const slugConflict = await prisma.article.findFirst({
        where: {
          id: { not: id },
          topicId: targetTopicId,
          slug,
        },
      });
      if (slugConflict) {
        return NextResponse.json({ error: "Article with this slug already exists in this topic" }, { status: 409 });
      }
      updateData.slug = slug.trim();
    }

    // content
    if (content !== undefined) {
      if (typeof content !== "string") {
        return NextResponse.json({ error: "content must be a string" }, { status: 400 });
      }
      const encoded = new TextEncoder().encode(content);
      if (encoded.length > 1024 * 1024) {
        return NextResponse.json({ error: "content exceeds maximum size of 1MB" }, { status: 400 });
      }
      updateData.content = content;

      // Auto-update excerpt if content changed and no explicit excerpt provided
      if (excerpt === undefined) {
        updateData.excerpt = content.slice(0, 160).replace(/[#*`_]/g, "");
      }
    }

    // excerpt
    if (excerpt !== undefined) {
      if (excerpt !== null && typeof excerpt !== "string") {
        return NextResponse.json({ error: "excerpt must be a string or null" }, { status: 400 });
      }
      if (excerpt && excerpt.length > 500) {
        return NextResponse.json({ error: "excerpt exceeds maximum length of 500 characters" }, { status: 400 });
      }
      updateData.excerpt = excerpt ?? "";
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
      if (!["draft", "reviewed", "published"].includes(status)) {
        return NextResponse.json({ error: "status must be one of: draft, reviewed, published" }, { status: 400 });
      }
      updateData.status = status;
    }

    // confidence
    if (confidence !== undefined) {
      if (!["low", "medium", "high"].includes(confidence)) {
        return NextResponse.json({ error: "confidence must be one of: low, medium, high" }, { status: 400 });
      }
      updateData.confidence = confidence;
    }

    // relatedArticleIds
    if (relatedArticleIds !== undefined) {
      if (!Array.isArray(relatedArticleIds)) {
        return NextResponse.json({ error: "relatedArticleIds must be an array" }, { status: 400 });
      }
      updateData.relatedArticleIds = JSON.stringify(relatedArticleIds);
    }

    // lastReviewed
    if (lastReviewed !== undefined) {
      if (lastReviewed !== null && (typeof lastReviewed !== "string" && typeof lastReviewed !== "number")) {
        return NextResponse.json({ error: "lastReviewed must be an ISO timestamp, Unix timestamp, or null" }, { status: 400 });
      }
      updateData.lastReviewed = lastReviewed ? new Date(lastReviewed) : null;
    }

    // tags — validate early if provided
    if (tags !== undefined) {
      if (!Array.isArray(tags) || !(tags as unknown[]).every((t) => typeof t === "string")) {
        return NextResponse.json({ error: "tags must be an array of strings" }, { status: 400 });
      }
    }

    // Build tag connections if tags are being updated
    let newTagConnections: { tagId: string }[] = [];
    if (tags !== undefined) {
      newTagConnections = await buildTagConnections(tags as string[]);
    }

    // Create revision if content or title changed
    const titleChanged = title !== undefined && title !== existing.title;
    const contentChanged = content !== undefined && content !== existing.content;

    if (titleChanged || contentChanged) {
      updateData.revisions = {
        create: {
          authorId: session?.user ? (session.user as { id: string }).id : null,
          title: (title ?? existing.title) as string,
          content: (content ?? existing.content) as string,
        },
      };
    }

    // Execute update with tag reconnect if tags changed
    const article = await prisma.article.update({
      where: { id },
      data: updateData,
      include: { topic: true },
    });

    // Reconnect tags if they changed
    if (tags !== undefined) {
      // Remove all existing tag connections
      await prisma.articleTag.deleteMany({ where: { articleId: id } });
      // Create new connections
      if (newTagConnections.length > 0) {
        await prisma.articleTag.createMany({
          data: newTagConnections.map((tc) => ({ articleId: id, tagId: tc.tagId })),
        });
      }
    }

    // Fetch updated tags
    const updatedArticle = await prisma.article.findUnique({
      where: { id },
      include: {
        topic: true,
        tags: { include: { tag: true } },
      },
    });

    return NextResponse.json({
      id: updatedArticle!.id,
      title: updatedArticle!.title,
      slug: updatedArticle!.slug,
      excerpt: updatedArticle!.excerpt,
      topic: { id: updatedArticle!.topic.id, name: updatedArticle!.topic.name, slug: updatedArticle!.topic.slug },
      tags: updatedArticle!.tags.map((t) => ({ id: t.tag.id, name: t.tag.name, slug: t.tag.slug })),
      confidence: updatedArticle!.confidence,
      status: updatedArticle!.status,
      lastReviewed: updatedArticle!.lastReviewed,
      relatedArticleIds: updatedArticle!.relatedArticleIds
        ? JSON.parse(updatedArticle!.relatedArticleIds)
        : null,
      createdAt: updatedArticle!.createdAt,
      updatedAt: updatedArticle!.updatedAt,
    });
  } catch (error) {
    console.error("[PATCH /api/articles/[id]]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
