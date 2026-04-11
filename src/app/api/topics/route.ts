import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/topics — List all topics (hierarchical tree)
export async function GET() {
  try {
    const topics = await prisma.topic.findMany({
      where: { parentId: null }, // Root topics only
      include: {
        children: {
          include: {
            children: {
              include: {
                children: true,
              },
            },
          },
        },
      },
      orderBy: { name: "asc" },
    });

    // Get article counts per topic
    const topicIds = collectAllTopicIds(topics);
    const counts = await prisma.article.groupBy({
      by: ["topicId"],
      _count: { id: true },
      where: { topicId: { in: topicIds }, deletedAt: null },
    });

    const countMap = new Map(counts.map((c) => [c.topicId, c._count.id]));

    const formatted = topics.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      description: t.description,
      articleCount: countMap.get(t.id) ?? 0,
      children: (t.children ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        description: c.description,
        articleCount: countMap.get(c.id) ?? 0,
        children: ((c as Record<string, unknown>).children as typeof topics ?? []).map((gc) => ({
          id: gc.id,
          name: gc.name,
          slug: gc.slug,
          description: gc.description,
          articleCount: countMap.get(gc.id) ?? 0,
          children: (gc as Record<string, unknown>).children ?? [],
        })),
      })),
    }));

    return NextResponse.json({ topics: formatted });
  } catch (error) {
    console.error("[GET /api/topics]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

function collectAllTopicIds(topics: Array<{ id: string; children?: Array<{ id: string; children?: Array<{ id: string }> }> }>): string[] {
  const ids: string[] = [];
  for (const t of topics) {
    ids.push(t.id);
    if (t.children) {
      for (const c of t.children) {
        ids.push(c.id);
        if (c.children) {
          for (const gc of c.children) {
            ids.push(gc.id);
          }
        }
      }
    }
  }
  return ids;
}
