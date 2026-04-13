import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/topics — List all topics (full hierarchical tree, unlimited depth)
export async function GET() {
  try {
    // Fetch ALL topics in one query (no depth limit)
    const allTopics = await prisma.topic.findMany({
      include: {
        _count: { select: { articles: true } },
      },
      orderBy: { name: "asc" },
    });

    // Get article counts per topic (excluding soft-deleted)
    const counts = await prisma.article.groupBy({
      by: ["topicId"],
      _count: { id: true },
      where: { topicId: { in: allTopics.map((t) => t.id) }, deletedAt: null },
    });
    const countMap = new Map(counts.map((c) => [c.topicId, c._count.id]));

    // Build tree in JS — supports unlimited nesting depth
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

    // First pass: create tree nodes
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

    // Second pass: link children to parents
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
