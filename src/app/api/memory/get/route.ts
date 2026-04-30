import { NextRequest, NextResponse } from "next/server";
import { Permissions } from "@prisma/client";
import { requirePermission } from "@/lib/api/auth";
import { executeMemoryGetRequest } from "@/lib/memory/api/get";

export async function POST(request: NextRequest) {
  const auth = await requirePermission(request, [Permissions.READ]);
  if (!auth.success) {
    return auth.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  try {
    const result = await executeMemoryGetRequest(body);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error("[POST /api/memory/get]", error);
    return NextResponse.json(
      { error: "Memory lookup unavailable" },
      { status: 503 },
    );
  }
}
