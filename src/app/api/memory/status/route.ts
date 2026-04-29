import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/auth";
import { getMemoryStatusSnapshot } from "@/lib/memory/api/providers";

export async function GET(request: NextRequest) {
  // ADMIN required: status exposes internal provider configuration
  // (priority weights, capabilities, max results) — operational data,
  // not article content, so WRITE is insufficient.
  const auth = await requirePermission(request, ["ADMIN"]);
  if (!auth.success) {
    return auth.response;
  }

  try {
    return NextResponse.json(getMemoryStatusSnapshot());
  } catch (error) {
    console.error("[GET /api/memory/status]", error);
    return NextResponse.json(
      {
        ok: false,
        timestamp: new Date().toISOString(),
        error: "Memory status unavailable",
      },
      { status: 503 },
    );
  }
}
