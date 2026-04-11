import { NextRequest, NextResponse } from "next/server";
import type { Permissions } from "@prisma/client";
import { requireApiKey } from "./keys";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export interface AuthResult {
    authorized: boolean;
    permissions?: Permissions;
    keyId?: string;
    role?: string;
    userId?: string;
}

/**
 * Check API key or session authorization for a route.
 */
export async function checkRouteAuth(
    request: NextRequest
): Promise<AuthResult> {
    try {
        const apiAuth = await requireApiKey(request);
        const session = await getServerSession(authOptions);

        if (!apiAuth.authorized && !session?.user) {
            return { authorized: false };
        }

        if (apiAuth.authorized) {
            return {
                authorized: true,
                permissions: apiAuth.permissions,
                keyId: apiAuth.keyId,
            };
        }

        const user = session?.user as { role?: string; id?: string };
        return {
            authorized: true,
            role: user?.role,
            userId: user?.id,
        };
    } catch (error) {
        console.error("[Auth] Backend error:", error instanceof Error ? error.message : "Unknown error");
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
const ROLE_LEVELS: Record<string, number> = {
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
        // Map permissions to equivalent role levels
        const requiredLevels = required.map((p) => {
            if (p === "ADMIN") return 3; // ADMIN permissions
            if (p === "WRITE") return 2; // EDITOR role
            return 1; // READ permissions
        });
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
): Promise<{ success: true; auth: AuthResult } | { success: false; response: NextResponse }> {
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
            response: NextResponse.json({ error: "Insufficient permissions" }, { status: 403 }),
        };
    }

    return { success: true, auth };
}
