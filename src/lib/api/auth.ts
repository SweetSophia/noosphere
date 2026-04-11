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
}

/**
 * Verify API key has required permission level.
 */
export function hasPermission(
    auth: AuthResult,
    required: Permissions[]
): boolean {
    if (auth.permissions) {
        return required.includes(auth.permissions);
    }
    if (auth.role) {
        const roleHierarchy: Record<string, number> = {
            VIEWER: 1,
            EDITOR: 2,
            ADMIN: 3,
        };
        const userLevel = roleHierarchy[auth.role] ?? 0;
        const requiredLevels = required.map((p) => {
            if (p === "ADMIN") return 3;
            if (p === "WRITE") return 2;
            return 1;
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
