import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/wiki";
import { checkRouteAuth } from "@/lib/api/auth";
import { rateLimit } from "@/lib/rate-limit";

// GET /api/topics — List all topics (existing)
export async function GET(request: NextRequest) {
  const rl = rateLimit(request, { windowMs: 60_000, maxRequests: 60, keyPrefix: "topics-get" });
  if (!rl.allowed) return rl.response;
  try {
    const allTopics = await prisma.topic.findMany({
      include: {
        _count: { select: { articles: true } },
      },
      orderBy: { name: "asc" },
    });

    const counts = await prisma.article.groupBy({
      by: ["topicId"],
      _count: { id: true },
      where: { topicId: { in: allTopics.map((t) => t.id) }, deletedAt: null },
    });
    const countMap = new Map(counts.map((c) => [c.topicId, c._count.id]));

    type TopicTree = {
      id: string;
      name: string;
      slug: string;
      description: string | null;
      articleCount: number;
      children: TopicTree[];
    };

    const topicMap = new Map<string, TopicTree>();
    const roots: TopicTree[] = [];

    for (const topic of allTopics) {
      topicMap.set(topic.id, {
        id: topic.id,
        name: topic.name,
        slug: topic.slug,
        description: topic.description,
        articleCount: countMap.get(topic.id) ?? topic._count.articles,
        children: [],
      });
    }

    for (const topic of allTopics) {
      const node = topicMap.get(topic.id)!;
      if (topic.parentId && topicMap.has(topic.parentId)) {
        topicMap.get(topic.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return NextResponse.json({ topics: roots });
  } catch (error) {
    console.error("[GET /api/topics]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/topics — Create a topic or subtopic
export async function POST(request: NextRequest) {
  const rl = rateLimit(request, { windowMs: 60_000, maxRequests: 30, keyPrefix: "topics-post" });
  if (!rl.allowed) return rl.response;

  const auth = await checkRouteAuth(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (auth.role !== "EDITOR" && auth.role !== "ADMIN") {
    return NextResponse.json({ error: "Editor or admin role required" }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { name, slug, parentId, description } = body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const finalSlug = slug
      ? slugify(slug)
      : slugify(name);

    if (!finalSlug) {
      return NextResponse.json({ error: "Could not derive a valid slug from name" }, { status: 400 });
    }

    // Validate parent exists if provided
    if (parentId) {
      const parent = await prisma.topic.findUnique({ where: { id: parentId } });
      if (!parent) {
        return NextResponse.json({ error: "Parent topic not found" }, { status: 400 });
      }
    }

    // Ensure slug is unique — auto-append counter if collision
    let finalFinalSlug = finalSlug;
    let counter = 1;
    while (await prisma.topic.findUnique({ where: { slug: finalFinalSlug } })) {
      finalFinalSlug = `${finalSlug}-${counter}`;
      counter++;
    }

    const topic = await prisma.topic.create({
      data: {
        name: name.trim(),
        slug: finalFinalSlug,
        parentId: parentId ?? null,
        description: typeof description === "string" ? description.trim() || null : null,
      },
    });

    return NextResponse.json(topic, { status: 201 });
  } catch (error) {
    console.error("[POST /api/topics]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
