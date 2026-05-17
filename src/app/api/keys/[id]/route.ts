import { NextRequest, NextResponse } from "next/server";
import { Permissions } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/api/auth";
import { rateLimit } from "@/lib/rate-limit";

// GET /api/keys/[id] — Get a single key's metadata
// Auth: ADMIN only
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rl = rateLimit(_request, { windowMs: 60_000, maxRequests: 30, keyPrefix: "keys-get-id" });
  if (!rl.allowed) return rl.response;

  const { id } = await params;
  const auth = await requirePermission(_request, [Permissions.ADMIN]);
  if (!auth.success) {
    return auth.response;
  }

  const key = await prisma.apiKey.findFirst({
    where: { id, revokedAt: null },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      permissions: true,
      allowedScopes: true,
      lastUsedAt: true,
      createdAt: true,
    },
  });

  if (!key) {
    return NextResponse.json({ error: "API key not found" }, { status: 404 });
  }

  return NextResponse.json({ key });
}

// PATCH /api/keys/[id] — Update allowedScopes on a key
// Auth: ADMIN only
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rl = rateLimit(request, { windowMs: 60_000, maxRequests: 30, keyPrefix: "keys-patch" });
  if (!rl.allowed) return rl.response;

  const { id } = await params;
  const auth = await requirePermission(request, [Permissions.ADMIN]);
  if (!auth.success) {
    return auth.response;
  }

  try {
    const body = await request.json();
    const { allowedScopes, permissions, name } = body;

    const existing = await prisma.apiKey.findFirst({
      where: { id, revokedAt: null },
    });

    if (!existing) {
      return NextResponse.json({ error: "API key not found" }, { status: 404 });
    }

    const updateData: { allowedScopes?: string[]; permissions?: Permissions; name?: string } = {};

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        return NextResponse.json({ error: "name must be a non-empty string" }, { status: 400 });
      }
      if (name.length > 64) {
        return NextResponse.json({ error: "name must be 64 characters or less" }, { status: 400 });
      }
      updateData.name = name.trim();
    }

    if (permissions !== undefined) {
      if (!["READ", "WRITE", "ADMIN"].includes(permissions)) {
        return NextResponse.json({ error: "permissions must be READ, WRITE, or ADMIN" }, { status: 400 });
      }
      updateData.permissions = permissions;
    }

    if (allowedScopes !== undefined) {
      if (!Array.isArray(allowedScopes) || !(allowedScopes as unknown[]).every((s) => typeof s === "string" && s.length > 0)) {
        return NextResponse.json({ error: "allowedScopes must be an array of non-empty strings" }, { status: 400 });
      }
      if (allowedScopes.length > 0) {
        const validScopes = await prisma.restrictedScope.findMany({
          where: { tag: { in: allowedScopes } },
          select: { tag: true },
        });
        const validSet = new Set(validScopes.map((s) => s.tag));
        const invalid = (allowedScopes as string[]).filter((s) => !validSet.has(s) && s !== "*");
        if (invalid.length > 0) {
          return NextResponse.json(
            { error: `Unknown scope(s): ${invalid.join(", ")}. Valid scopes: ${validScopes.map((s) => s.tag).join(", ")}` },
            { status: 400 }
          );
        }
      }
      updateData.allowedScopes = allowedScopes;
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    const updated = await prisma.apiKey.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        permissions: true,
        allowedScopes: true,
        lastUsedAt: true,
        createdAt: true,
      },
    });

    return NextResponse.json({ key: updated });
  } catch (error) {
    console.error("[Keys] PATCH error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] — Revoke an API key
// Auth: ADMIN only
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rl = rateLimit(_request, { windowMs: 60_000, maxRequests: 30, keyPrefix: "keys-delete" });
  if (!rl.allowed) return rl.response;

  const { id } = await params;
  const auth = await requirePermission(_request, [Permissions.ADMIN]);
  if (!auth.success) {
    return auth.response;
  }

  const existing = await prisma.apiKey.findFirst({
    where: { id, revokedAt: null },
  });

  if (!existing) {
    return NextResponse.json({ error: "API key not found" }, { status: 404 });
  }

  await prisma.apiKey.update({
    where: { id },
    data: { revokedAt: new Date() },
  });

  return NextResponse.json({ success: true });
}
