import { NextRequest, NextResponse } from "next/server";
import { Permissions } from "@prisma/client";
import { requirePermission, type AuthResult } from "@/lib/api/auth";
import { withApiErrorBoundary } from "@/lib/api/errors";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { quarantineMemoryCapture } from "@/lib/memory/capture/lifecycle";
import { MemoryCaptureError } from "@/lib/memory/capture/repository";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const rate = await rateLimit(request, {
    windowMs: 60_000,
    maxRequests: 30,
    keyPrefix: "memory-capture-detail-get",
  });
  if (!rate.allowed) return rate.response;
  const auth = await requirePermission(request, [Permissions.WRITE]);
  if (!auth.success) return auth.response;
  const { id } = await params;
  const capture = await prisma.memoryCapture.findUnique({
    where: { id },
    include: {
      agentPrincipal: {
        select: { id: true, name: true, status: true, revokedAt: true },
      },
      provenanceEdges: {
        select: {
          generationSnapshot: true,
          lineageState: {
            select: { id: true, kind: true, generation: true, revokedAt: true },
          },
        },
      },
    },
  });
  if (!capture) return NextResponse.json({ error: "Memory capture not found" }, { status: 404 });
  if (!canInspectMemoryCapture(auth.auth, capture)) {
    return NextResponse.json({ error: "Insufficient scope" }, { status: 403 });
  }
  const response = NextResponse.json({ capture });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withApiErrorBoundary("MemoryCaptures DELETE", async () => {
    const rate = await rateLimit(request, {
      windowMs: 60_000,
      maxRequests: 20,
      keyPrefix: "memory-capture-delete",
    });
    if (!rate.allowed) return rate.response;
    const auth = await requirePermission(request, [Permissions.ADMIN]);
    if (!auth.success) return auth.response;
    const { id } = await params;
    const capture = await prisma.memoryCapture.findUnique({
      where: { id },
      select: { agentPrincipalId: true, privateScopeTag: true },
    });
    if (!capture) {
      return NextResponse.json({ error: "Memory capture not found" }, { status: 404 });
    }
    if (!canInspectMemoryCapture(auth.auth, capture)) {
      return NextResponse.json({ error: "Insufficient scope" }, { status: 403 });
    }
    try {
      const result = await quarantineMemoryCapture(id);
      return NextResponse.json({ success: true, ...result });
    } catch (error) {
      if (error instanceof MemoryCaptureError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
  });
}

export function canInspectMemoryCapture(
  auth: AuthResult,
  capture: {
    agentPrincipalId: string;
    privateScopeTag: string;
    status?: string;
    quarantinedAt?: Date | null;
    expiresAt?: Date;
    agentPrincipal?: { status: string; revokedAt?: Date | null };
  },
): boolean {
  // Human administrators retain full inspection access. API permission and
  // restricted-scope authorization remain separate capabilities.
  if (!auth.keyId) {
    return auth.role === "ADMIN" && auth.allowedScopes?.includes("*") === true;
  }

  const hasScope =
    auth.allowedScopes?.includes("*") === true ||
    auth.allowedScopes?.includes(capture.privateScopeTag) === true;
  if (!hasScope) return false;

  // Scope-authorized administrators retain inspection access for explicit
  // privacy review. A creator's WRITE credential is a polling capability, not
  // a quarantine bypass: raw turn text becomes unavailable immediately when
  // either the capture or its principal is no longer eligible.
  if (auth.permissions === Permissions.ADMIN) return true;
  if (
    auth.permissions !== Permissions.WRITE ||
    auth.agentPrincipalId !== capture.agentPrincipalId
  ) {
    return false;
  }
  return (
    capture.quarantinedAt == null &&
    capture.status !== "QUARANTINED" &&
    capture.status !== "EXPIRED" &&
    (capture.expiresAt === undefined || capture.expiresAt.getTime() > Date.now()) &&
    capture.agentPrincipal?.status === "ACTIVE" &&
    capture.agentPrincipal.revokedAt == null
  );
}
