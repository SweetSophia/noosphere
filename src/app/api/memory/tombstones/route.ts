import { NextRequest, NextResponse } from "next/server";
import { MemoryLineageKind, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authorizeMemoryAdminList, readBoundedFilter } from "@/lib/memory/capture/admin-list";

export async function GET(request: NextRequest) {
  const access = await authorizeMemoryAdminList(request, "memory-tombstones-get");
  if (!access.ok) return access.response;
  const kind = readBoundedFilter(access.searchParams, "kind", 32);
  if (!kind.ok) return NextResponse.json({ error: kind.error }, { status: 400 });
  if (kind.value && !Object.values(MemoryLineageKind).includes(kind.value as MemoryLineageKind)) {
    return NextResponse.json({ error: "Invalid tombstone kind" }, { status: 400 });
  }
  const where: Prisma.MemoryTombstoneWhereInput = {};
  if (kind.value) where.kind = kind.value as MemoryLineageKind;
  const [tombstones, total] = await Promise.all([
    prisma.memoryTombstone.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: access.pagination.offset,
      take: access.pagination.limit,
    }),
    prisma.memoryTombstone.count({ where }),
  ]);
  return NextResponse.json({ tombstones, total, ...access.pagination });
}
