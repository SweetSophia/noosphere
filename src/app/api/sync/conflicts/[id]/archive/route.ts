/**
 * GET /api/sync/conflicts/:id/archive
 *
 * Serves archived local markdown copies for admin conflict review.
 */

export const dynamic = "force-dynamic";

import { readFile } from "fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { Permissions } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/api/auth";
import { getObsidianSyncConfig } from "@/lib/obsidian-sync/config";
import { resolveVaultArchivePath } from "@/lib/markdown-sync/conflict-review";
import { rateLimit } from "@/lib/rate-limit";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rl = rateLimit(request, { windowMs: 60_000, maxRequests: 30, keyPrefix: "sync-conflict-archive-get" });
  if (!rl.allowed) return rl.response;

  const auth = await requirePermission(request, [Permissions.ADMIN]);
  if (!auth.success) {
    return auth.response;
  }

  const config = getObsidianSyncConfig();
  if (!config) {
    return NextResponse.json({ error: "Obsidian sync is not enabled" }, { status: 400 });
  }

  const { id } = await params;
  const review = await prisma.syncConflictReview.findUnique({
    where: { id },
    select: { archivePath: true, relativePath: true },
  });

  if (!review) {
    return NextResponse.json({ error: "Conflict not found" }, { status: 404 });
  }

  const absolutePath = resolveVaultArchivePath(config.vaultPath, review.archivePath);
  if (!absolutePath) {
    return NextResponse.json({ error: "Archived conflict path is invalid" }, { status: 404 });
  }

  try {
    const content = await readFile(absolutePath, "utf-8");
    const filename = (review.relativePath.split("/").pop() ?? "conflict.md").replace(/[^\w.-]/g, "_");
    return new NextResponse(content, {
      status: 200,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `inline; filename="${filename.replace(/"/g, "")}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "Archived conflict file not found" }, { status: 404 });
  }
}
