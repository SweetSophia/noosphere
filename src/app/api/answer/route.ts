import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiKey } from "@/lib/api/keys";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

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
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { title, content, topicId, excerpt, tags, sourceQuery, confidence, status, authorName } = body;
  const sessionUser = session?.user as ({ id?: string } | null) | undefined;
  const userId = sessionUser?.id ?? null;

  // Validate required fields
  if (!title || !content || !topicId) {
    return NextResponse.json(
      { error: "title, content, and topicId are required" },
      { status: 400 }
    );
  }

  // Validate enums
  if (status && !["draft", "reviewed", "published"].includes(status)) {
    return NextResponse.json({ error: "status must be draft/reviewed/published" }, { status: 400 });
  }
  if (confidence && !["low", "medium", "high"].includes(confidence)) {
    return NextResponse.json({ error: "confidence must be low/medium/high" }, { status: 400 });
  }

  // Verify topic exists
  const topic = await prisma.topic.findUnique({ where: { id: topicId } });
  if (!topic) {
    return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  }

  // Derive slug from title
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim()
    .slice(0, 80);

  if (!slug) {
    return NextResponse.json({ error: "Could not derive a valid slug from title" }, { status: 400 });
  }

  // Check slug uniqueness
  const existing = await prisma.article.findUnique({
    where: { topicId_slug: { topicId, slug } },
  });
  if (existing) {
    return NextResponse.json(
      { error: `Article with slug "${slug}" already exists in this topic`, existingArticleId: existing.id },
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
  const derivedExcerpt =
    excerpt ||
    content.slice(0, 200).replace(/[#*`_>\-\[\]]/g, "").trim();

  const article = await prisma.$transaction(async (tx) => {
    const created = await tx.article.create({
      data: {
        title,
        slug,
        content,
        excerpt: derivedExcerpt,
        topicId,
        authorId: userId,
        authorName: authorName || session?.user?.name || "Unknown",
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
        authorName: authorName || session?.user?.name || "Unknown",
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
