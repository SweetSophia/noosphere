import { NextRequest, NextResponse } from "next/server";
import { Permissions } from "@prisma/client";
import { requirePermission } from "@/lib/api/auth";
import { readBoundedJson, RequestBodyTooLargeError, JsonDepthExceededError } from "@/lib/api/body";
import { executeMemoryGetRequest } from "@/lib/memory/api/get";
import { rateLimit } from "@/lib/rate-limit";

export async function POST(request: NextRequest) {
  const rl = await rateLimit(request, { windowMs: 60_000, maxRequests: 30, keyPrefix: "memory-get" });
  if (!rl.allowed) return rl.response;

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
    const result = await executeMemoryGetRequest(body, {
      allowedScopes: auth.auth.allowedScopes,
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error("[POST /api/memory/get]", error);
    return NextResponse.json(
      { error: "Memory lookup unavailable" },
      { status: 503 },
    );
  }
}
