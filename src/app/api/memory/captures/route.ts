import { NextRequest, NextResponse } from "next/server";
import { getJsonBodyError, readBoundedJson } from "@/lib/api/body";
import { requireApiKey } from "@/lib/api/keys";
import { rateLimit } from "@/lib/rate-limit";
import { executeMemoryCaptureRequest } from "@/lib/memory/capture/api";
import { readAutomaticMemoryCaptureConfig } from "@/lib/memory/capture/config";
import { MemoryCaptureStatus, Permissions, Prisma } from "@prisma/client";
import { requirePermission } from "@/lib/api/auth";
import { prisma } from "@/lib/prisma";
import { parsePagination } from "@/lib/pagination";
import {
  authorizedMemoryPrivateScopes,
  privateMemoryAdminResponse,
} from "@/lib/memory/capture/admin-list";

const CAPTURE_STATUSES = new Set([
  "PENDING",
  "PROCESSING",
  "CONVERTED",
  "IGNORED",
  "FAILED",
  "EXPIRED",
  "QUARANTINED",
]);

export async function GET(request: NextRequest) {
  const rate = await rateLimit(request, {
    windowMs: 60_000,
    maxRequests: 30,
    keyPrefix: "memory-captures-get",
  });
  if (!rate.allowed) return rate.response;
  const auth = await requirePermission(request, [Permissions.ADMIN]);
  if (!auth.success) return auth.response;

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const principalId = searchParams.get("principalId");
  if (status && !CAPTURE_STATUSES.has(status)) {
    return NextResponse.json({ error: "Invalid capture status" }, { status: 400 });
  }
  if (principalId && principalId.length > 128) {
    return NextResponse.json({ error: "principalId is too long" }, { status: 400 });
  }
  const pagination = parsePagination(searchParams, { limit: 25, maxLimit: 100 });
  const authorizedScopes = authorizedMemoryPrivateScopes(auth.auth.allowedScopes);
  const where: Prisma.MemoryCaptureWhereInput = authorizedScopes
    ? { privateScopeTag: { in: authorizedScopes } }
    : {};
  if (status) where.status = status as MemoryCaptureStatus;
  if (principalId) where.agentPrincipalId = principalId;

  const [captures, total] = await Promise.all([
    prisma.memoryCapture.findMany({
      where,
      select: {
        id: true,
        dedupeKeyVersion: true,
        hmacAlgorithm: true,
        agentPrincipalId: true,
        privateScopeTag: true,
        sourceType: true,
        status: true,
        occurrenceCount: true,
        attemptCount: true,
        expiresAt: true,
        quarantinedAt: true,
        firstSeenAt: true,
        lastSeenAt: true,
        createdAt: true,
        updatedAt: true,
        agentPrincipal: { select: { name: true, status: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: pagination.offset,
      take: pagination.limit,
    }),
    prisma.memoryCapture.count({ where }),
  ]);
  return privateMemoryAdminResponse(
    NextResponse.json({ captures, total, ...pagination }),
  );
}

export async function POST(request: NextRequest) {
  const rate = await rateLimit(request, {
    windowMs: 60_000,
    maxRequests: 30,
    keyPrefix: "memory-captures-post",
  });
  if (!rate.allowed) return rate.response;

  // Automatic capture is an agent-only ingestion boundary. Human admin
  // sessions can inspect it but cannot manufacture agent identity.
  const auth = await requireApiKey(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let config;
  try {
    config = readAutomaticMemoryCaptureConfig();
  } catch (error) {
    console.error(
      "[POST /api/memory/captures] invalid configuration:",
      error instanceof Error ? error.message : "unknown configuration error",
    );
    return NextResponse.json(
      { error: "Automatic memory capture is not configured" },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await readBoundedJson(request);
  } catch (error) {
    const bodyError = getJsonBodyError(error);
    return NextResponse.json(
      { error: bodyError.message },
      { status: bodyError.status },
    );
  }

  try {
    const result = await executeMemoryCaptureRequest(body, {
      auth: {
        keyId: auth.keyId,
        agentPrincipalId: auth.agentPrincipalId,
      },
      config,
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error(
      "[POST /api/memory/captures] unavailable:",
      error instanceof Error ? error.name : "unknown error",
    );
    return NextResponse.json(
      { error: "Automatic memory capture unavailable" },
      { status: 503 },
    );
  }
}
