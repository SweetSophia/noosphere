import { Permissions } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "./auth";

/**
 * Key management is a global control plane: even a self-update or permission-only
 * change can grant access beyond the actor's content scopes. Do not interpret
 * ADMIN permission alone as delegation authority. Human ADMIN sessions already
 * receive explicit full scope through the shared authentication contract.
 */
export async function requireGlobalKeyManagement(request: NextRequest) {
  const result = await requirePermission(request, [Permissions.ADMIN]);
  if (!result.success) return result;

  if (!result.auth.allowedScopes?.includes("*")) {
    return {
      success: false as const,
      response: NextResponse.json({ error: "Insufficient permissions" }, { status: 403 }),
    };
  }

  return result;
}
