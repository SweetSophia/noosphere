import { NextRequest, NextResponse } from "next/server";
import { Permissions } from "@prisma/client";
import { requirePermission } from "@/lib/api/auth";
import { getJsonBodyError, readBoundedJsonObject } from "@/lib/api/body";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { createMemoryAgentPrincipal } from "@/lib/memory/capture/lifecycle";
import { MemoryCaptureError } from "@/lib/memory/capture/repository";

export async function GET(request: NextRequest) {
  const rate = await rateLimit(request, {
    windowMs: 60_000,
    maxRequests: 30,
    keyPrefix: "memory-principals-get",
  });
  if (!rate.allowed) return rate.response;
  const auth = await requirePermission(request, [Permissions.ADMIN]);
  if (!auth.success) return auth.response;
  const principals = await prisma.memoryAgentPrincipal.findMany({
    orderBy: [{ status: "asc" }, { name: "asc" }],
    include: {
      _count: { select: { apiKeys: true, captures: true, candidates: true } },
    },
  });
  return NextResponse.json({ principals });
}

export async function POST(request: NextRequest) {
  const rate = await rateLimit(request, {
    windowMs: 60_000,
    maxRequests: 20,
    keyPrefix: "memory-principals-post",
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
    (key) => key !== "name" && key !== "privateScopeTag",
  );
  if (unknown.length > 0) {
    return NextResponse.json(
      { error: `Unknown field(s): ${unknown.sort().join(", ")}` },
      { status: 400 },
    );
  }
  if (typeof body.name !== "string" || typeof body.privateScopeTag !== "string") {
    return NextResponse.json(
      { error: "name and privateScopeTag are required" },
      { status: 400 },
    );
  }
  try {
    const principal = await createMemoryAgentPrincipal({
      name: body.name,
      privateScopeTag: body.privateScopeTag,
    });
    return NextResponse.json({ principal }, { status: 201 });
  } catch (error) {
    if (error instanceof MemoryCaptureError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2002"
    ) {
      return NextResponse.json({ error: "Principal name already exists" }, { status: 409 });
    }
    throw error;
  }
}
