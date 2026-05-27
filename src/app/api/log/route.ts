import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/api/auth";
import { rateLimit } from "@/lib/rate-limit";

// GET /api/log — Query the activity log
//
// Query params:
//   type       — filter by event type ("ingest", "create", "update", "delete", "lint")
//   author     — filter by author name
//   from       — ISO date string, inclusive lower bound
//   to         — ISO date string, exclusive upper bound
//   limit      — max entries to return (default 50, max 200)
//   offset     — pagination offset
//
// Response:
//   { entries: [{id, type, title, details, sourceUrl, authorName, createdAt}], total, limit, offset }

export async function GET(request: NextRequest) {
  const rl = await rateLimit(request, { windowMs: 60_000, maxRequests: 30, keyPrefix: "log-get" });
  if (!rl.allowed) return rl.response;

  // Auth: API key (any permission) or session
  const auth = await requirePermission(request, []);
  if (!auth.success) {
    return auth.response;
  }

  const { searchParams } = new URL(request.url);

  const type = searchParams.get("type");
  const author = searchParams.get("author");
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(searchParams.get("offset") ?? "0", 10);

  // Build where clause
  const where: Prisma.ActivityLogWhereInput = {};

  if (type) {
    where.type = type;
  }

  if (author) {
    where.authorName = { equals: author, mode: "insensitive" };
  }

  if (from || to) {
    const createdAt: Prisma.DateTimeFilter = {};
    if (from) {
      createdAt.gte = new Date(from);
    }
    if (to) {
      createdAt.lt = new Date(to);
    }
    where.createdAt = createdAt;
  }

  const [entries, total] = await Promise.all([
    prisma.activityLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.activityLog.count({ where }),
  ]);

  return NextResponse.json({
    entries,
    total,
    limit,
    offset,
  });
}
