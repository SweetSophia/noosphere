import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/wiki";
import { checkRouteAuth } from "@/lib/api/auth";
import { rateLimit } from "@/lib/rate-limit";
import { invalidateSearchCache } from "@/lib/cache/search-cache";

interface Props {
  params: Promise<{ id: string }>;
}

// PATCH /api/tags/[id] — Rename a tag
export async function PATCH(request: NextRequest, { params }: Props) {
  const rl = rateLimit(request, { windowMs: 60_000, maxRequests: 30, keyPrefix: "tags-patch" });
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
    const body = await request.json();
    const { name } = body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const existing = await prisma.tag.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Tag not found" }, { status: 404 });
    }

    const newSlug = slugify(name);
    if (!newSlug) {
      return NextResponse.json({ error: "Could not derive a valid slug from name" }, { status: 400 });
    }

    // Check for slug collision (excluding self)
    if (newSlug !== existing.slug) {
      const slugConflict = await prisma.tag.findUnique({ where: { slug: newSlug } });
      if (slugConflict) {
        return NextResponse.json({ error: `Slug "${newSlug}" is already in use` }, { status: 409 });
      }
    }

    const updated = await prisma.tag.update({
      where: { id },
      data: { name: name.trim(), slug: newSlug },
    });

    await invalidateSearchCache();

    return NextResponse.json({ id: updated.id, name: updated.name, slug: updated.slug });
  } catch (error) {
    console.error("[PATCH /api/tags/[id]]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/tags/[id] — Delete a tag
export async function DELETE(request: NextRequest, { params }: Props) {
  const rl = rateLimit(request, { windowMs: 60_000, maxRequests: 30, keyPrefix: "tags-delete" });
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
    const existing = await prisma.tag.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Tag not found" }, { status: 404 });
    }

    // Block if tag is in use
    const articleCount = await prisma.articleTag.count({ where: { tagId: id } });
    if (articleCount > 0) {
      return NextResponse.json(
        { error: `Cannot delete tag "${existing.name}" — it is used by ${articleCount} article(s). Remove it from articles first.` },
        { status: 409 }
      );
    }

    await prisma.tag.delete({ where: { id } });
    await invalidateSearchCache();
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("[DELETE /api/tags/[id]]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
