import { NextRequest, NextResponse } from "next/server";
import type { Permissions, Role } from "@prisma/client";
import { requireApiKey } from "./keys";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export interface AuthResult {
  authorized: boolean;
  permissions?: Permissions;
  keyId?: string;
  /** Scopes this key is allowed to access. Empty = only unrestricted articles.
   *  Sessions always get ["*"] (full access). */
  allowedScopes?: string[];
  role?: Role;
  userId?: string;
  name?: string;
}

/**
 * Check API key or session authorization for a route.
 */
export async function checkRouteAuth(
  request: NextRequest
): Promise<AuthResult> {
  // First check API key - return immediately if valid
  const apiAuth = await requireApiKey(request);
  if (apiAuth.authorized) {
    return {
      authorized: true,
      permissions: apiAuth.permissions,
      keyId: apiAuth.keyId,
      allowedScopes: apiAuth.allowedScopes,
    };
  }

  // Only check session if API key is not authorized
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return { authorized: false };
    }
    // Sessions (humans) have full access to all content including restricted
    return {
      authorized: true,
      role: session.user.role,
      userId: session.user.id,
      name: session.user.name ?? undefined,
      allowedScopes: ["*"], // Human sessions bypass all scope restrictions
    };
  } catch (error) {
    console.error(
      "[Auth] Session error:",
      error instanceof Error ? error.message : "Unknown error"
    );
    return { authorized: false };
  }
}

/**
 * Map permissions to numeric level for hierarchical comparison.
 */
const PERMISSION_LEVELS: Record<Permissions, number> = {
  READ: 1,
  WRITE: 2,
  ADMIN: 3,
};

/**
 * Map roles to numeric level for hierarchical comparison.
 */
const ROLE_LEVELS: Record<Role, number> = {
  VIEWER: 1,
  EDITOR: 2,
  ADMIN: 3,
};

/**
 * Verify API key or session has required permission level.
 * Empty required array = "allow if authenticated"
 * Uses hierarchical comparison (ADMIN can access WRITE/READ routes)
 */
export function hasPermission(
  auth: AuthResult,
  required: Permissions[]
): boolean {
  // Empty required array = allow any authenticated user
  if (required.length === 0) {
    return auth.authorized;
  }

  // Check API key permissions with hierarchy
  if (auth.permissions) {
    const userLevel = PERMISSION_LEVELS[auth.permissions];
    const requiredLevels = required.map((p) => PERMISSION_LEVELS[p]);
    return requiredLevels.some((level) => level <= userLevel);
  }

  // Check session role with hierarchy
  if (auth.role) {
    const userLevel = ROLE_LEVELS[auth.role] ?? 0;
    // Reuse PERMISSION_LEVELS — role and permission hierarchies use the same values
    const requiredLevels = required.map((p) => PERMISSION_LEVELS[p]);
    return requiredLevels.some((level) => level <= userLevel);
  }

  return false;
}

/**
 * Require authenticated request with specific permissions.
 */
export async function requirePermission(
  request: NextRequest,
  required: Permissions[]
): Promise<
  | { success: true; auth: AuthResult }
  | { success: false; response: NextResponse }
> {
  const auth = await checkRouteAuth(request);

  if (!auth.authorized) {
    return {
      success: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  if (!hasPermission(auth, required)) {
    return {
      success: false,
      response: NextResponse.json(
        { error: "Insufficient permissions" },
        { status: 403 }
      ),
    };
  }

  return { success: true, auth };
}

/**
 * Build a Prisma WHERE clause that filters articles based on key scopes.
 * Articles with no restrictedTags are always accessible.
 * Articles with restrictedTags require at least one matching scope.
 *
 * @param allowedScopes - The scopes available to the current key (from AuthResult)
 * @param extraWhere - Additional Prisma filters to AND with the scope filter
 */
export function buildScopeFilter(
  allowedScopes: string[] | undefined,
  extraWhere: Record<string, unknown> = {}
): Record<string, unknown> {
  // If scopes include "*", grant admin access — no scope restriction at all
  if (allowedScopes?.includes("*")) {
    return extraWhere;
  }

  // No scopes at all (undefined or empty): can only access unrestricted articles
  if (!allowedScopes || allowedScopes.length === 0) {
    return {
      ...extraWhere,
      restrictedTags: { isEmpty: true },
    };
  }

  // Non-admin key with scopes: unrestricted OR at least one matching scope
  return {
    ...extraWhere,
    OR: [
      { restrictedTags: { isEmpty: true } },
      { restrictedTags: { hasSome: allowedScopes } },
    ],
  };
}

/**
 * Check whether the current auth context grants access to a given article's restricted scopes.
 * Returns true if the article is unrestricted OR has at least one matching scope.
 *
 * @param articleScopes - restrictedTags from the article
 * @param allowedScopes - scopes from AuthResult
 */
export function canAccessScopes(
  articleScopes: string[],
  allowedScopes: string[] | undefined
): boolean {
  if (articleScopes.length === 0) return true; // unrestricted
  if (allowedScopes?.includes("*")) return true; // admin bypass
  if (!allowedScopes || allowedScopes.length === 0) return false; // no scope access
  return articleScopes.some((s) => allowedScopes.includes(s));
}
