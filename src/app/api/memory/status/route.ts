import { NextResponse } from "next/server";
import { requireApiKey } from "@/lib/api/keys";
import { getMemoryStatusSnapshot } from "@/lib/memory/api/providers";

export async function GET(request: Request) {
  const auth = await requireApiKey(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(getMemoryStatusSnapshot());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[GET /api/memory/status]", message);
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
