import { NextRequest, NextResponse } from "next/server";
import { Permissions } from "@prisma/client";
import { requirePermission } from "@/lib/api/auth";
import { withApiErrorBoundary } from "@/lib/api/errors";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { revokeMemoryAgentPrincipal } from "@/lib/memory/capture/lifecycle";
import { MemoryCaptureError } from "@/lib/memory/capture/repository";
import {
  canAccessMemoryPrivateScope,
  privateMemoryAdminResponse,
  visibleMemoryApiKeyScopes,
} from "@/lib/memory/capture/admin-list";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withApiErrorBoundary("MemoryPrincipals GET", async () => {
    const rate = await rateLimit(request, {
      windowMs: 60_000,
      maxRequests: 30,
      keyPrefix: "memory-principal-detail-get",
    });
    if (!rate.allowed) return rate.response;
    const auth = await requirePermission(request, [Permissions.ADMIN]);
    if (!auth.success) return auth.response;
    const { id } = await params;
    const principal = await prisma.memoryAgentPrincipal.findUnique({
      where: { id },
      include: {
        apiKeys: {
          select: {
            id: true,
            name: true,
            keyPrefix: true,
            permissions: true,
            allowedScopes: true,
            revokedAt: true,
          },
        },
        _count: { select: { captures: true, candidates: true, retrievalStats: true } },
      },
    });
    if (!principal) return NextResponse.json({ error: "Memory principal not found" }, { status: 404 });
    if (!canAccessMemoryPrivateScope(auth.auth.allowedScopes, principal.privateScopeTag)) {
      return NextResponse.json({ error: "Insufficient scope" }, { status: 403 });
    }
    return privateMemoryAdminResponse(
      NextResponse.json({
        principal: {
          ...principal,
          apiKeys: principal.apiKeys.map((apiKey) => ({
            ...apiKey,
            allowedScopes: visibleMemoryApiKeyScopes(
              auth.auth.allowedScopes,
              apiKey.allowedScopes,
            ),
          })),
        },
      }),
    );
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withApiErrorBoundary("MemoryPrincipals DELETE", async () => {
    const rate = await rateLimit(request, {
      windowMs: 60_000,
      maxRequests: 20,
      keyPrefix: "memory-principal-delete",
    });
    if (!rate.allowed) return rate.response;
    const auth = await requirePermission(request, [Permissions.ADMIN]);
    if (!auth.success) return auth.response;
    const { id } = await params;
    const principal = await prisma.memoryAgentPrincipal.findUnique({
      where: { id },
      select: { privateScopeTag: true },
    });
    if (!principal) {
      return NextResponse.json({ error: "Memory principal not found" }, { status: 404 });
    }
    if (!canAccessMemoryPrivateScope(auth.auth.allowedScopes, principal.privateScopeTag)) {
      return NextResponse.json({ error: "Insufficient scope" }, { status: 403 });
    }
    try {
      const result = await revokeMemoryAgentPrincipal(id);
      return privateMemoryAdminResponse(
        NextResponse.json({ success: true, ...result }),
      );
    } catch (error) {
      if (error instanceof MemoryCaptureError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
  });
}
