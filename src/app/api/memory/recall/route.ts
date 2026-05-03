import { NextRequest, NextResponse } from "next/server";
import { Permissions } from "@prisma/client";
import { requirePermission } from "@/lib/api/auth";
import { readBoundedJson, RequestBodyTooLargeError, JsonDepthExceededError } from "@/lib/api/body";
import { executeMemoryRecallRequest } from "@/lib/memory/api/recall";

export async function POST(request: NextRequest) {
  const auth = await requirePermission(request, [Permissions.READ]);
  if (!auth.success) {
    return auth.response;
  }

  let body: unknown;
  try {
    body = await readBoundedJson(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError || error instanceof JsonDepthExceededError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const result = await executeMemoryRecallRequest(body);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error("[POST /api/memory/recall]", error);
    return NextResponse.json(
      { error: "Memory recall unavailable" },
      { status: 503 },
    );
  }
}
