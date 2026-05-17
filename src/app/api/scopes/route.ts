import { NextRequest, NextResponse } from "next/server";
import { Permissions } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/api/auth";
import { rateLimit } from "@/lib/rate-limit";

// GET /api/scopes — List all available restricted scopes
// Auth: Any valid API key (READ minimum)
export async function GET(request: NextRequest) {
  const rl = rateLimit(request, { windowMs: 60_000, maxRequests: 60, keyPrefix: "scopes-get" });
  if (!rl.allowed) return rl.response;

  const auth = await requirePermission(request, [Permissions.READ]);
  if (!auth.success) {
    return auth.response;
  }

  const scopes = await prisma.restrictedScope.findMany({
    orderBy: [{ isSystem: "desc" }, { tag: "asc" }],
    select: { tag: true, description: true, isSystem: true, createdAt: true },
  });

  return NextResponse.json({ scopes });
}

// POST /api/scopes — Register a new custom scope
// Auth: ADMIN only
export async function POST(request: NextRequest) {
  const rl = rateLimit(request, { windowMs: 60_000, maxRequests: 30, keyPrefix: "scopes-post" });
  if (!rl.allowed) return rl.response;

  const auth = await requirePermission(request, [Permissions.ADMIN]);
  if (!auth.success) {
    return auth.response;
  }

  try {
    const { tag, description } = await request.json();

    if (!tag || typeof tag !== "string") {
      return NextResponse.json({ error: "tag is required and must be a string" }, { status: 400 });
    }

    // Validate tag format: lowercase alphanumeric + hyphen only
    if (!/^[a-z0-9-]+$/.test(tag)) {
      return NextResponse.json(
        { error: "tag must be lowercase alphanumeric with hyphens only (e.g. 'company-x')" },
        { status: 400 }
      );
    }

    if (description !== undefined && typeof description !== "string") {
      return NextResponse.json({ error: "description must be a string" }, { status: 400 });
    }

    // Check tag doesn't already exist
    const existing = await prisma.restrictedScope.findUnique({ where: { tag } });
    if (existing) {
      return NextResponse.json({ error: `Scope '${tag}' already exists` }, { status: 409 });
    }

    const scope = await prisma.restrictedScope.create({
      data: { tag, description: description ?? null, isSystem: false },
      select: { tag: true, description: true, isSystem: true, createdAt: true },
    });

    return NextResponse.json(scope, { status: 201 });
  } catch (error) {
    console.error("[Scopes] POST error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
