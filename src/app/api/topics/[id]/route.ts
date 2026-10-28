import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/wiki";
import { checkRouteAuth, hasPermission } from "@/lib/api/auth";
import { Permissions } from "@prisma/client";
import { getJsonBodyError, readBoundedJsonObject } from "@/lib/api/body";
import { rateLimit } from "@/lib/rate-limit";
import { invalidateSearchCache } from "@/lib/cache/search-cache";
import { TaxonomyConflict, updateTopicSafely } from "@/lib/taxonomy";

interface Props {
  params: Promise<{ id: string }>;
}

// PATCH /api/topics/[id] — Update a topic
export async function PATCH(request: NextRequest, { params }: Props) {
  const rl = await rateLimit(request, { windowMs: 60_000, maxRequests: 30, keyPrefix: "topics-patch" });
  if (!rl.allowed) return rl.response;

  const auth = await checkRouteAuth(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Renames and moves affect shared taxonomy across article scopes.
  // Full scope and the operation permission are independent requirements.
  if (!hasPermission(auth, [Permissions.WRITE]) || !auth.allowedScopes?.includes("*")) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
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

    const updated = await updateTopicSafely(id, {
      name, parentId, description,
      ...(slug !== undefined ? { slug: slugify(slug) } : {}),
    });

    await invalidateSearchCache();

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof TaxonomyConflict) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
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
  // ADMIN permission alone must not bypass the shared-taxonomy scope gate.
  if (!hasPermission(auth, [Permissions.ADMIN]) || !auth.allowedScopes?.includes("*")) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
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
