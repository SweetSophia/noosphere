import { NextRequest, NextResponse } from "next/server";
import { Permissions } from "@prisma/client";
import { requirePermission } from "@/lib/api/auth";
import { executeMemoryRecallRequest } from "@/lib/memory/api/recall";

export async function POST(request: NextRequest) {
  const auth = await requirePermission(request, [Permissions.READ]);
  if (!auth.success) {
    return auth.response;
  }

  try {
    const result = await executeMemoryRecallRequest(await request.json());
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error("[POST /api/memory/recall]", error);
    return NextResponse.json(
      { error: "Memory recall unavailable" },
      { status: 503 },
    );
  }
}
