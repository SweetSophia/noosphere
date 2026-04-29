import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/auth";
import { getMemoryStatusSnapshot } from "@/lib/memory/api/providers";

export async function GET(request: NextRequest) {
  const auth = await requirePermission(request, ["WRITE"]);
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
