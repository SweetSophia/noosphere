import { NextRequest, NextResponse } from "next/server";
import { MemoryJobStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  authorizeMemoryAdminList,
  authorizedMemoryLineageWhere,
  privateMemoryAdminResponse,
  readBoundedFilter,
} from "@/lib/memory/capture/admin-list";

export async function GET(request: NextRequest) {
  const access = await authorizeMemoryAdminList(request, "memory-jobs-get");
  if (!access.ok) return access.response;
  const status = readBoundedFilter(access.searchParams, "status", 32);
  const kind = readBoundedFilter(access.searchParams, "kind", 64);
  if (!status.ok) return NextResponse.json({ error: status.error }, { status: 400 });
  if (!kind.ok) return NextResponse.json({ error: kind.error }, { status: 400 });
  if (status.value && !Object.values(MemoryJobStatus).includes(status.value as MemoryJobStatus)) {
    return NextResponse.json({ error: "Invalid job status" }, { status: 400 });
  }
  const lineageScope = authorizedMemoryLineageWhere(access.allowedScopes);
  const where: Prisma.MemoryDurableJobWhereInput = lineageScope
    ? { lineageState: lineageScope }
    : {};
  if (status.value) where.status = status.value as MemoryJobStatus;
  if (kind.value) where.kind = kind.value;
  const [jobs, total] = await Promise.all([
    prisma.memoryDurableJob.findMany({
      where,
      orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
      skip: access.pagination.offset,
      take: access.pagination.limit,
    }),
    prisma.memoryDurableJob.count({ where }),
  ]);
  return privateMemoryAdminResponse(
    NextResponse.json({ jobs, total, ...access.pagination }),
  );
}
