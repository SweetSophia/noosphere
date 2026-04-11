import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiKey } from "@/lib/api/keys";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import type { Permissions } from "@prisma/client";

// GET /api/articles — List articles (with filters)
// Auth: API key (READ/WRITE/ADMIN) or session (human)
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const topicSlug = searchParams.get("topic");
  const tag = searchParams.get("tag");
  const q = searchParams.get("q"); // full-text search
  const page = parseInt(searchParams.get("page") ?? "1");
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "20"), 100);

  try {
    const where: Record<string, unknown> = { deletedAt: null };

    if (topicSlug) {
      where.topic = { slug: topicSlug };
    }

    if (tag) {
      where.tags = { some: { tag: { slug: tag } } };
    }

    if (q) {
      where.OR = [
        { title: { contains: q, mode: "insensitive" } },
        { content: { contains: q, mode: "insensitive" } },
        { excerpt: { contains: q, mode: "insensitive" } },
      ];
    }

    const [articles, total] = await Promise.all([
      prisma.article.findMany({
        where,
        include: {
          topic: true,
          tags: { include: { tag: true } },
          author: { select: { id: true, name: true, email: true } },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { updatedAt: "desc" },
      }),
      prisma.article.count({ where }),
    ]);

    const formatted = articles.map((a) => ({
      id: a.id,
      title: a.title,
      slug: a.slug,
      excerpt: a.excerpt,
      topic: { id: a.topic.id, name: a.topic.name, slug: a.topic.slug },
      tags: a.tags.map((t) => ({ id: t.tag.id, name: t.tag.name, slug: t.tag.slug })),
      author: a.author ? { id: a.author.id, name: a.author.name } : { name: a.authorName },
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
    const body = await request.json();
    const { title, slug, content, topicId, tags, excerpt, authorName } = body;

    if (!title || !slug || !content || !topicId) {
      return NextResponse.json(
        { error: "Missing required fields: title, slug, content, topicId" },
        { status: 400 }
      );
    }

    // Validate slug format
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return NextResponse.json(
        { error: "Slug must be lowercase alphanumeric with hyphens only" },
        { status: 400 }
      );
    }

    // Check topic exists
    const topic = await prisma.topic.findUnique({ where: { id: topicId } });
    if (!topic) {
      return NextResponse.json({ error: "Topic not found" }, { status: 404 });
    }

    // Check slug uniqueness within topic
    const existing = await prisma.article.findUnique({
      where: { topicId_slug: { topicId, slug } },
    });
    if (existing) {
      return NextResponse.json(
        { error: "Article with this slug already exists in this topic" },
        { status: 409 }
      );
    }

    // Handle tags
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

    const article = await prisma.article.create({
      data: {
        title,
        slug,
        content,
        excerpt: excerpt || content.slice(0, 160).replace(/[#*`_]/g, ""),
        topicId,
        authorId: session?.user ? (session.user as { id: string }).id : null,
        authorName: authorName || (session?.user?.name ?? null),
        tags: { create: tagConnections },
      },
      include: {
        topic: true,
        tags: { include: { tag: true } },
      },
    });

    return NextResponse.json(
      {
        id: article.id,
        title: article.title,
        slug: article.slug,
        topic: article.topic,
        tags: article.tags.map((t) => t.tag),
        createdAt: article.createdAt,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("[POST /api/articles]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
