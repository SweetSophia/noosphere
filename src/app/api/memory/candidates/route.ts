import { NextRequest, NextResponse } from "next/server";
import { MemoryCandidateStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authorizeMemoryAdminList, readBoundedFilter } from "@/lib/memory/capture/admin-list";

export async function GET(request: NextRequest) {
  const access = await authorizeMemoryAdminList(request, "memory-candidates-get");
  if (!access.ok) return access.response;
  const status = readBoundedFilter(access.searchParams, "status", 32);
  const principalId = readBoundedFilter(access.searchParams, "principalId");
  if (!status.ok) return NextResponse.json({ error: status.error }, { status: 400 });
  if (!principalId.ok) {
    return NextResponse.json({ error: principalId.error }, { status: 400 });
  }
  if (status.value && !Object.values(MemoryCandidateStatus).includes(status.value as MemoryCandidateStatus)) {
    return NextResponse.json({ error: "Invalid candidate status" }, { status: 400 });
  }
  const where: Prisma.MemoryCandidateWhereInput = {};
  if (status.value) where.status = status.value as MemoryCandidateStatus;
  if (principalId.value) where.agentPrincipalId = principalId.value;
  const [candidates, total] = await Promise.all([
    prisma.memoryCandidate.findMany({
      where,
      select: {
        id: true,
        title: true,
        confidence: true,
        searchTerms: true,
        agentPrincipalId: true,
        privateScopeTag: true,
        status: true,
        occurrenceCount: true,
        retrievedCount: true,
        injectedCount: true,
        explicitGetCount: true,
        distinctSessionCount: true,
        distinctDayCount: true,
        expiresAt: true,
        quarantinedAt: true,
        promotedArticleId: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: access.pagination.offset,
      take: access.pagination.limit,
    }),
    prisma.memoryCandidate.count({ where }),
  ]);
  return NextResponse.json({ candidates, total, ...access.pagination });
}
