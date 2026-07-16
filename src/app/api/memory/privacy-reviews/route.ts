import { NextRequest, NextResponse } from "next/server";
import { MemoryPrivacyReviewStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  authorizeMemoryAdminList,
  authorizedMemoryLineageWhere,
  privateMemoryAdminResponse,
  readBoundedFilter,
} from "@/lib/memory/capture/admin-list";

export async function GET(request: NextRequest) {
  const access = await authorizeMemoryAdminList(request, "memory-privacy-reviews-get");
  if (!access.ok) return access.response;
  const status = readBoundedFilter(access.searchParams, "status", 32);
  if (!status.ok) return NextResponse.json({ error: status.error }, { status: 400 });
  if (status.value && !Object.values(MemoryPrivacyReviewStatus).includes(status.value as MemoryPrivacyReviewStatus)) {
    return NextResponse.json({ error: "Invalid privacy review status" }, { status: 400 });
  }
  const lineageScope = authorizedMemoryLineageWhere(access.allowedScopes);
  const where: Prisma.MemoryPrivacyReviewWhereInput = lineageScope
    ? { lineageState: lineageScope }
    : {};
  if (status.value) where.status = status.value as MemoryPrivacyReviewStatus;
  const [reviews, total] = await Promise.all([
    prisma.memoryPrivacyReview.findMany({
      where,
      include: { article: { select: { id: true, title: true, status: true, recallQuarantinedAt: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: access.pagination.offset,
      take: access.pagination.limit,
    }),
    prisma.memoryPrivacyReview.count({ where }),
  ]);
  return privateMemoryAdminResponse(
    NextResponse.json({ reviews, total, ...access.pagination }),
  );
}
