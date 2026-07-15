import { NextRequest, NextResponse } from "next/server";
import { Permissions } from "@prisma/client";
import { requirePermission } from "@/lib/api/auth";
import { getJsonBodyError, readBoundedJsonObject } from "@/lib/api/body";
import { withApiErrorBoundary } from "@/lib/api/errors";
import { rateLimit } from "@/lib/rate-limit";
import { readAutomaticMemoryCaptureConfig } from "@/lib/memory/capture/config";
import { revokeMemorySession } from "@/lib/memory/capture/lifecycle";
import { MemoryCaptureError } from "@/lib/memory/capture/repository";

export async function POST(request: NextRequest) {
  return withApiErrorBoundary("MemoryRevocations POST", async () => {
    const rate = await rateLimit(request, {
      windowMs: 60_000,
      maxRequests: 20,
      keyPrefix: "memory-revocations-post",
    });
    if (!rate.allowed) return rate.response;
    const auth = await requirePermission(request, [Permissions.ADMIN]);
    if (!auth.success) return auth.response;

    let body: Record<string, unknown>;
    try {
      body = await readBoundedJsonObject(request);
    } catch (error) {
      const bodyError = getJsonBodyError(error);
      return NextResponse.json({ error: bodyError.message }, { status: bodyError.status });
    }
    const unknown = Object.keys(body).filter(
      (key) => !["kind", "principalId", "sourceSessionId"].includes(key),
    );
    if (unknown.length > 0) {
      return NextResponse.json(
        { error: `Unknown field(s): ${unknown.sort().join(", ")}` },
        { status: 400 },
      );
    }
    if (
      body.kind !== "session" ||
      typeof body.principalId !== "string" ||
      !body.principalId.trim() ||
      typeof body.sourceSessionId !== "string" ||
      !body.sourceSessionId.trim() ||
      body.sourceSessionId.length > 512
    ) {
      return NextResponse.json(
        { error: "kind=session, principalId, and a bounded sourceSessionId are required" },
        { status: 400 },
      );
    }

    let config;
    try {
      config = readAutomaticMemoryCaptureConfig();
    } catch {
      return NextResponse.json(
        { error: "Automatic-memory maintenance keyring is invalid" },
        { status: 503 },
      );
    }
    if (!config.hmacKeyring) {
      return NextResponse.json(
        { error: "Automatic-memory maintenance keyring is unavailable" },
        { status: 503 },
      );
    }

    try {
      const result = await revokeMemorySession({
        principalId: body.principalId.trim(),
        sourceSessionId: body.sourceSessionId.trim(),
        keyring: config.hmacKeyring,
      });
      return NextResponse.json({ success: true, ...result });
    } catch (error) {
      if (error instanceof MemoryCaptureError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
  });
}
