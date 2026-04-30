import { NextRequest, NextResponse } from "next/server";
import { Permissions } from "@prisma/client";
import { requirePermission } from "@/lib/api/auth";
import { readBoundedJsonBody, RequestBodyTooLargeError } from "@/lib/api/body";
import { executeMemoryGetRequest } from "@/lib/memory/api/get";

export async function POST(request: NextRequest) {
  const auth = await requirePermission(request, [Permissions.READ]);
  if (!auth.success) {
    return auth.response;
  }

  let body: unknown;
  try {
    const rawBody = await readBoundedJsonBody(request);
    body = JSON.parse(rawBody);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
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
