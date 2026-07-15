import { NextRequest, NextResponse } from "next/server";
import { Permissions } from "@prisma/client";
import { requirePermission } from "@/lib/api/auth";
import { withApiErrorBoundary } from "@/lib/api/errors";
import { rateLimit } from "@/lib/rate-limit";
import { deleteMemoryRestrictedScope } from "@/lib/memory/capture/lifecycle";
import { MemoryCaptureError } from "@/lib/memory/capture/repository";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tag: string }> },
) {
  return withApiErrorBoundary("Scopes DELETE", async () => {
    const rate = await rateLimit(request, {
      windowMs: 60_000,
      maxRequests: 20,
      keyPrefix: "scopes-delete",
    });
    if (!rate.allowed) return rate.response;
    const auth = await requirePermission(request, [Permissions.ADMIN]);
    if (!auth.success) return auth.response;
    const { tag } = await params;
    if (!/^[a-z0-9-]{1,64}$/.test(tag)) {
      return NextResponse.json({ error: "Invalid scope tag" }, { status: 400 });
    }
    try {
      const result = await deleteMemoryRestrictedScope(tag);
      return NextResponse.json({ success: true, ...result });
    } catch (error) {
      if (error instanceof MemoryCaptureError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
  });
}
