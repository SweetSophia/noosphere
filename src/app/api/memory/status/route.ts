import { NextRequest, NextResponse } from "next/server";
import { Permissions } from "@prisma/client";
import { requirePermission } from "@/lib/api/auth";
import { getMemoryStatusSnapshot } from "@/lib/memory/api/providers";
import { getRecallSettingsFromDB } from "@/lib/memory/api/settings";

export async function GET(request: NextRequest) {
  // ADMIN required: status exposes internal provider configuration
  // (priority weights, capabilities, max results) — operational data,
  // not article content, so WRITE is insufficient.
  // NOTE: API key validation requires the database (key lookup + lastUsedAt
  // update). If the DB is unreachable, API key auth fails and the request
  // falls back to session auth, which also requires the DB.
  const auth = await requirePermission(request, [Permissions.ADMIN]);
  if (!auth.success) {
    return auth.response;
  }

  try {
    const settings = await getRecallSettingsFromDB();
    return NextResponse.json(getMemoryStatusSnapshot({ settings }));
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
