import { NextRequest, NextResponse } from "next/server";
import { Prisma, Permissions } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/api/auth";
import { rateLimit } from "@/lib/rate-limit";
import { sanitizeAuthorName } from "@/lib/validation";
import { parseDateFilter } from "@/lib/log-validation";

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

  // Auth: API key (ADMIN) or admin session
  const auth = await requirePermission(request, [Permissions.ADMIN]);
  if (!auth.success) {
    return auth.response;
  }

  const { searchParams } = new URL(request.url);

  const MAX_TYPE_LENGTH = 50;

  const type = searchParams.get("type");
  if (type && type.length > MAX_TYPE_LENGTH) {
    return NextResponse.json({ error: "type parameter too long" }, { status: 400 });
  }

  const rawAuthor = searchParams.get("author");
  const author = sanitizeAuthorName(rawAuthor);

  const from = searchParams.get("from");
  const to = searchParams.get("to");

  const dateFilter = parseDateFilter(from, to);
  if (!dateFilter.ok) {
    return NextResponse.json({ error: dateFilter.error }, { status: 400 });
  }

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

  if (dateFilter.from || dateFilter.to) {
    const createdAt: Prisma.DateTimeFilter = {};
    if (dateFilter.from) {
      createdAt.gte = dateFilter.from;
    }
    if (dateFilter.to) {
      createdAt.lt = dateFilter.to;
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
