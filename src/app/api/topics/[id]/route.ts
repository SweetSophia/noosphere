import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/wiki";
import { checkRouteAuth } from "@/lib/api/auth";
import { getJsonBodyError, readBoundedJsonObject } from "@/lib/api/body";
import { rateLimit } from "@/lib/rate-limit";
import { invalidateSearchCache } from "@/lib/cache/search-cache";

interface Props {
  params: Promise<{ id: string }>;
}

// Recursive descendant check for cycle detection
async function getDescendantIds(topicId: string): Promise<string[]> {
  const children = await prisma.topic.findMany({
    where: { parentId: topicId },
    select: { id: true },
  });
  const descendants: string[] = [];
  for (const child of children) {
    descendants.push(child.id);
    const subDescendants = await getDescendantIds(child.id);
    descendants.push(...subDescendants);
  }
  return descendants;
}

// PATCH /api/topics/[id] — Update a topic
export async function PATCH(request: NextRequest, { params }: Props) {
  const rl = await rateLimit(request, { windowMs: 60_000, maxRequests: 30, keyPrefix: "topics-patch" });
  if (!rl.allowed) return rl.response;

  const auth = await checkRouteAuth(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (auth.role !== "EDITOR" && auth.role !== "ADMIN") {
    return NextResponse.json({ error: "Editor or admin role required" }, { status: 403 });
  }

  const { id } = await params;

  try {
    let body: {
      name?: string;
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

    const existing = await prisma.topic.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Topic not found" }, { status: 404 });
    }

    const finalSlug = slug !== undefined
      ? slugify(slug)
      : existing.slug;

    // Validate parent if provided
    let finalParentId: string | null = existing.parentId;
    if (parentId !== undefined) {
      if (parentId === id) {
        return NextResponse.json({ error: "A topic cannot be its own parent" }, { status: 400 });
      }

      if (parentId !== null) {
        const parent = await prisma.topic.findUnique({ where: { id: parentId } });
        if (!parent) {
          return NextResponse.json({ error: "Parent topic not found" }, { status: 400 });
        }

        // Cycle check: parent cannot be a descendant of this topic
        const descendants = await getDescendantIds(id);
        if (descendants.includes(parentId)) {
          return NextResponse.json({ error: "Cannot set a descendant as the parent (cycle)" }, { status: 400 });
        }
      }

      finalParentId = parentId;
    }

    // If slug is changing, ensure it's not already taken
    if (finalSlug !== existing.slug) {
      const slugConflict = await prisma.topic.findUnique({ where: { slug: finalSlug } });
      if (slugConflict) {
        return NextResponse.json({ error: "Slug already in use by another topic" }, { status: 409 });
      }
    }

    const updated = await prisma.topic.update({
      where: { id },
      data: {
        name: name !== undefined ? name.trim() : existing.name,
        slug: finalSlug,
        parentId: finalParentId,
        description: description !== undefined
          ? (typeof description === "string" ? description.trim() || null : null)
          : existing.description,
      },
    });

    await invalidateSearchCache();

    return NextResponse.json(updated);
  } catch (error) {
    console.error("[PATCH /api/topics/[id]]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/topics/[id] — Delete a topic
export async function DELETE(request: NextRequest, { params }: Props) {
  const rl = await rateLimit(request, { windowMs: 60_000, maxRequests: 30, keyPrefix: "topics-delete" });
  if (!rl.allowed) return rl.response;

  const auth = await checkRouteAuth(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (auth.role !== "ADMIN") {
    return NextResponse.json({ error: "Admin role required" }, { status: 403 });
  }

  const { id } = await params;

  try {
    const existing = await prisma.topic.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Topic not found" }, { status: 404 });
    }

    // Block if topic has articles (even soft-deleted — use total count)
    const articleCount = await prisma.article.count({ where: { topicId: id } });
    if (articleCount > 0) {
      return NextResponse.json(
        { error: `Cannot delete topic — it has ${articleCount} article(s). Move or delete them first.` },
        { status: 409 }
      );
    }

    // Block if topic has children
    const childCount = await prisma.topic.count({ where: { parentId: id } });
    if (childCount > 0) {
      return NextResponse.json(
        { error: `Cannot delete topic — it has ${childCount} subtopic(s). Delete or reassign them first.` },
        { status: 409 }
      );
    }

    await prisma.topic.delete({ where: { id } });
    await invalidateSearchCache();
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("[DELETE /api/topics/[id]]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
