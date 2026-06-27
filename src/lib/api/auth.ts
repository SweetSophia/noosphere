import { NextRequest, NextResponse } from "next/server";
import type { Permissions, Role } from "@prisma/client";
import { requireApiKey } from "./keys";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
export { buildScopeFilter, canAccessScopes } from "./scope-filter";

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
      name: apiAuth.name,
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
