import { Permissions } from "@prisma/client";
import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/api/auth";
import { rateLimit } from "@/lib/rate-limit";
import { parsePagination } from "@/lib/pagination";

export async function authorizeMemoryAdminList(
  request: NextRequest,
  keyPrefix: string,
) {
  const rate = await rateLimit(request, {
    windowMs: 60_000,
    maxRequests: 30,
    keyPrefix,
  });
  if (!rate.allowed) return { ok: false as const, response: rate.response };
  const auth = await requirePermission(request, [Permissions.ADMIN]);
  if (!auth.success) return { ok: false as const, response: auth.response };
  const { searchParams } = new URL(request.url);
  return {
    ok: true as const,
    searchParams,
    pagination: parsePagination(searchParams, { limit: 25, maxLimit: 100 }),
  };
}

export function readBoundedFilter(
  searchParams: URLSearchParams,
  name: string,
  maxLength = 128,
): { ok: true; value?: string } | { ok: false; error: string } {
  const value = searchParams.get(name)?.trim();
  if (!value) return { ok: true };
  if (value.length > maxLength) return { ok: false, error: `${name} is too long` };
  return { ok: true, value };
}
