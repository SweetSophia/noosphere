import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiKey } from "@/lib/api/keys";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

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
  // Auth: API key (any permission) or session
  const apiAuth = await requireApiKey(request);
  const session = await getServerSession(authOptions);
  if (!apiAuth.authorized && !session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);

  const type = searchParams.get("type");
  const author = searchParams.get("author");
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(searchParams.get("offset") ?? "0", 10);

  // Build where clause
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = {};

  if (type) {
    where.type = type;
  }

  if (author) {
    where.authorName = { equals: author, mode: "insensitive" };
  }

  if (from || to) {
    where.createdAt = {};
    if (from) {
      where.createdAt.gte = new Date(from);
    }
    if (to) {
      where.createdAt.lt = new Date(to);
    }
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
