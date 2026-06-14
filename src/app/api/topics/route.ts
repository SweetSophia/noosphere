import { NextRequest, NextResponse } from "next/server";
import { Permissions, type Topic } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/wiki";
import { buildScopeFilter, checkRouteAuth, hasPermission, requirePermission } from "@/lib/api/auth";
import { getJsonBodyError, readBoundedJsonObject } from "@/lib/api/body";
import { rateLimit } from "@/lib/rate-limit";

const TOPIC_TREE_MAX_TOPICS = 500;

// GET /api/topics — List all topics (existing)
export async function GET(request: NextRequest) {
  const rl = await rateLimit(request, { windowMs: 60_000, maxRequests: 60, keyPrefix: "topics-get" });
  if (!rl.allowed) return rl.response;

  const auth = await requirePermission(request, [Permissions.READ]);
  if (!auth.success) {
    return auth.response;
  }

  try {
    const fullAccess = auth.auth.allowedScopes?.includes("*") ?? false;
    let allTopics: Topic[];
    let countMap: Map<string, number>;

    if (fullAccess) {
      allTopics = await prisma.topic.findMany({
        take: TOPIC_TREE_MAX_TOPICS + 1,
        orderBy: { name: "asc" },
      });
      if (allTopics.length > TOPIC_TREE_MAX_TOPICS) {
        return topicTreeLimitExceededResponse();
      }

      const counts = await prisma.article.groupBy({
        by: ["topicId"],
        _count: { id: true },
        where: {
          topicId: { in: allTopics.map((topic) => topic.id) },
          deletedAt: null,
        },
      });
      countMap = new Map(counts.map((count) => [count.topicId, count._count.id]));
    } else {
      const counts = await prisma.article.groupBy({
        by: ["topicId"],
        _count: { id: true },
        where: buildScopeFilter(auth.auth.allowedScopes, { deletedAt: null }),
        orderBy: { topicId: "asc" },
        take: TOPIC_TREE_MAX_TOPICS + 1,
      });
      if (counts.length > TOPIC_TREE_MAX_TOPICS) {
        return topicTreeLimitExceededResponse();
      }

      countMap = new Map(counts.map((count) => [count.topicId, count._count.id]));
      const visibleTopicIds = new Set<string>();
      let pendingIds = [...countMap.keys()];

      while (pendingIds.length > 0) {
        const remaining = TOPIC_TREE_MAX_TOPICS - visibleTopicIds.size;
        const topics = await prisma.topic.findMany({
          where: { id: { in: pendingIds } },
          select: { id: true, parentId: true },
          orderBy: { id: "asc" },
          take: remaining + 1,
        });

        if (topics.length > remaining) {
          return topicTreeLimitExceededResponse();
        }

        const nextIds = new Set<string>();
        for (const topic of topics) {
          visibleTopicIds.add(topic.id);
          if (topic.parentId && !visibleTopicIds.has(topic.parentId)) {
            nextIds.add(topic.parentId);
          }
        }
        pendingIds = [...nextIds];
      }

      allTopics = visibleTopicIds.size === 0
        ? []
        : await prisma.topic.findMany({
            where: { id: { in: [...visibleTopicIds] } },
            orderBy: { name: "asc" },
            take: TOPIC_TREE_MAX_TOPICS,
          });
    }

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
        articleCount: countMap.get(topic.id) ?? 0,
        children: [],
      });
    }

    for (const topic of allTopics) {
      const node = topicMap.get(topic.id);
      if (!node) continue;
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

function topicTreeLimitExceededResponse() {
  return NextResponse.json(
    {
      error: `Topic tree exceeds the supported limit of ${TOPIC_TREE_MAX_TOPICS} topics`,
      code: "TOPIC_TREE_LIMIT_EXCEEDED",
      maxTopics: TOPIC_TREE_MAX_TOPICS,
    },
    { status: 409 },
  );
}

// POST /api/topics — Create a topic or subtopic
export async function POST(request: NextRequest) {
  const rl = await rateLimit(request, { windowMs: 60_000, maxRequests: 30, keyPrefix: "topics-post" });
  if (!rl.allowed) return rl.response;

  const auth = await checkRouteAuth(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const allowed = hasPermission(auth, [Permissions.WRITE]);
  if (!allowed) {
    return NextResponse.json(
      { error: "Write API key or editor/admin session required" },
      { status: 403 }
    );
  }

  try {
    const topicAtLimit = await prisma.topic.findFirst({
      orderBy: { id: "asc" },
      skip: TOPIC_TREE_MAX_TOPICS - 1,
      select: { id: true },
    });
    if (topicAtLimit) {
      return topicTreeLimitExceededResponse();
    }

    let body: {
      name?: unknown;
      slug?: string;
      parentId?: string | null;
      description?: unknown;
    };
    try {
      body = await readBoundedJsonObject<typeof body>(request);
    } catch (error) {
      const bodyError = getJsonBodyError(error);
      return NextResponse.json(
        { error: bodyError.message },
        { status: bodyError.status },
      );
    }
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
