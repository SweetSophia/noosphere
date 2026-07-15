import { NextRequest, NextResponse } from "next/server";
import { Permissions } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/api/auth";
import { getJsonBodyError, readBoundedJsonObject } from "@/lib/api/body";
import { createApiKeyRecord } from "@/lib/api/key-mutations";
import { MemoryCaptureError } from "@/lib/memory/capture/repository";
import { rateLimit } from "@/lib/rate-limit";

// GET /api/keys — List all API keys (metadata only)
// Auth: ADMIN only
export async function GET(_request: NextRequest) {
  const rl = await rateLimit(_request, { windowMs: 60_000, maxRequests: 30, keyPrefix: "keys-get" });
  if (!rl.allowed) return rl.response;

  const auth = await requirePermission(_request, [Permissions.ADMIN]);
  if (!auth.success) {
    return auth.response;
  }

  const keys = await prisma.apiKey.findMany({
    where: { revokedAt: null },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      permissions: true,
      allowedScopes: true,
      agentPrincipalId: true,
      agentPrincipal: {
        select: { name: true, privateScopeTag: true, status: true },
      },
      lastUsedAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ keys });
}

// POST /api/keys — Create a new API key
// Auth: ADMIN only
export async function POST(request: NextRequest) {
  const rl = await rateLimit(request, { windowMs: 60_000, maxRequests: 30, keyPrefix: "keys-post" });
  if (!rl.allowed) return rl.response;

  const auth = await requirePermission(request, [Permissions.ADMIN]);
  if (!auth.success) {
    return auth.response;
  }

  try {
    let body: Record<string, unknown>;
    try {
      body = await readBoundedJsonObject(request);
    } catch (error) {
      const bodyError = getJsonBodyError(error);
      return NextResponse.json(
        { error: bodyError.message },
        { status: bodyError.status },
      );
    }
    const { name, permissions, allowedScopes, agentPrincipalId } = body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "name is required and must be a non-empty string" }, { status: 400 });
    }
    if (name.length > 64) {
      return NextResponse.json({ error: "name must be 64 characters or less" }, { status: 400 });
    }
    if (!/^[a-zA-Z0-9-]+$/.test(name)) {
      return NextResponse.json({ error: "name must be alphanumeric with hyphens only" }, { status: 400 });
    }

    if (permissions !== undefined) {
      if (
        typeof permissions !== "string" ||
        !["READ", "WRITE", "ADMIN"].includes(permissions)
      ) {
        return NextResponse.json({ error: "permissions must be READ, WRITE, or ADMIN" }, { status: 400 });
      }
    }

    if (allowedScopes !== undefined) {
      if (!Array.isArray(allowedScopes) || !(allowedScopes as unknown[]).every((s) => typeof s === "string" && s.length > 0)) {
        return NextResponse.json({ error: "allowedScopes must be an array of non-empty strings" }, { status: 400 });
      }
      // Validate all scopes exist
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
    }

    if (
      agentPrincipalId !== undefined &&
      agentPrincipalId !== null &&
      (typeof agentPrincipalId !== "string" || !agentPrincipalId.trim())
    ) {
      return NextResponse.json(
        { error: "agentPrincipalId must be a non-empty string or null" },
        { status: 400 },
      );
    }

    const created = await createApiKeyRecord({
      name: name.trim(),
      permissions: (permissions as Permissions) ?? Permissions.WRITE,
      allowedScopes: (allowedScopes as string[] | undefined) ?? [],
      agentPrincipalId:
        typeof agentPrincipalId === "string" ? agentPrincipalId.trim() : null,
    });

    // Return raw key ONCE — it cannot be recovered
    return NextResponse.json(
      { ...created.key, key: created.raw },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof MemoryCaptureError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[Keys] POST error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
