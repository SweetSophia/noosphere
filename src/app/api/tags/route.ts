import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/wiki";
import { checkRouteAuth } from "@/lib/api/auth";

// GET /api/tags — List all tags with article counts
export async function GET() {
  try {
    const tags = await prisma.tag.findMany({
      include: {
        _count: { select: { articles: true } },
      },
      orderBy: { name: "asc" },
    });

    return NextResponse.json({
      tags: tags.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        articleCount: t._count.articles,
        createdAt: t.createdAt,
      })),
    });
  } catch (error) {
    console.error("[GET /api/tags]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/tags — Create a tag
export async function POST(request: NextRequest) {
  const auth = await checkRouteAuth(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (auth.role !== "EDITOR" && auth.role !== "ADMIN") {
    return NextResponse.json({ error: "Editor or admin role required" }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { name } = body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const tagSlug = slugify(name);
    if (!tagSlug) {
      return NextResponse.json({ error: "Could not derive a valid slug from name" }, { status: 400 });
    }

    // Check for name or slug collision
    const existing = await prisma.tag.findFirst({
      where: {
        OR: [{ name: name.trim() }, { slug: tagSlug }],
      },
    });
    if (existing) {
      return NextResponse.json(
        { error: `Tag "${name.trim()}" already exists` },
        { status: 409 }
      );
    }

    const tag = await prisma.tag.create({
      data: { name: name.trim(), slug: tagSlug },
    });

    return NextResponse.json({ id: tag.id, name: tag.name, slug: tag.slug }, { status: 201 });
  } catch (error) {
    console.error("[POST /api/tags]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
