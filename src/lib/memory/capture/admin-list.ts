import { MemoryLineageKind, Permissions, Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
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
    allowedScopes: auth.auth.allowedScopes,
    searchParams,
    pagination: parsePagination(searchParams, { limit: 25, maxLimit: 100 }),
  };
}

/**
 * Return `undefined` for callers that may inspect every private scope, or the
 * exact concrete scopes an API key may inspect. Automatic-memory artifacts
 * are always private, so an empty list authorizes no rows.
 */
export function authorizedMemoryPrivateScopes(
  allowedScopes: string[] | undefined,
): string[] | undefined {
  if (allowedScopes?.includes("*")) return undefined;
  return [...new Set(allowedScopes ?? [])];
}

export function canAccessMemoryPrivateScope(
  allowedScopes: string[] | undefined,
  privateScopeTag: string,
): boolean {
  const scopes = authorizedMemoryPrivateScopes(allowedScopes);
  return scopes === undefined || scopes.includes(privateScopeTag);
}

/** Hide scope names that the inspecting administrator is not authorized to see. */
export function visibleMemoryApiKeyScopes(
  allowedScopes: string[] | undefined,
  keyScopes: string[],
): string[] {
  const scopes = authorizedMemoryPrivateScopes(allowedScopes);
  if (scopes === undefined) return keyScopes;
  const visible = new Set(scopes);
  return keyScopes.filter((scope) => visible.has(scope));
}

export function privateMemoryAdminResponse(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

/**
 * Jobs, tombstones, and privacy reviews inherit scope through lineage rather
 * than a direct privateScopeTag column. Non-scope lineage is principal-bound;
 * canonical scope lineage deliberately has no principal relation.
 */
export function authorizedMemoryLineageWhere(
  allowedScopes: string[] | undefined,
): Prisma.MemoryLineageStateWhereInput | undefined {
  const scopes = authorizedMemoryPrivateScopes(allowedScopes);
  if (scopes === undefined) return undefined;
  return {
    OR: [
      {
        kind: { not: MemoryLineageKind.SCOPE },
        agentPrincipal: { privateScopeTag: { in: scopes } },
      },
      {
        kind: MemoryLineageKind.SCOPE,
        agentPrincipalId: null,
        subjectHash: { in: scopes.map((scope) => `scope:${scope}`) },
      },
    ],
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
