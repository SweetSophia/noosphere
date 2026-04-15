/**
 * POST /api/sync/obsidian
 *
 * Trigger an Obsidian shadow sync run.
 * Writes Noosphere articles to a local markdown vault.
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/api/keys";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getObsidianSyncConfig } from "@/lib/obsidian-sync/config";
import { runObsidianSync, SyncConflictError } from "@/lib/obsidian-sync";
import type { SyncOptions } from "@/lib/obsidian-sync";

// GET /api/sync/obsidian — return status / config visibility
export async function GET(request: NextRequest) {
  const apiAuth = await requireApiKey(request);
  const session = await getServerSession(authOptions);

  if (!apiAuth.authorized && !session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Require ADMIN for config visibility (vaultPath is server filesystem info)
  if (apiAuth.authorized) {
    if (apiAuth.permissions !== "ADMIN") {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }
  } else {
    const role = (session?.user as { role?: string }).role;
    if (role !== "ADMIN") {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }
  }

  try {
    const config = getObsidianSyncConfig();

    if (!config) {
      return NextResponse.json({
        enabled: false,
        message: "OBSIDIAN_SYNC_ENABLED is not set to true",
      });
    }

    return NextResponse.json({
      enabled: true,
      gitEnabled: config.gitEnabled,
      autoClean: config.autoClean,
      preserveLocalChanges: config.preserveLocalChanges,
      trashDeletions: config.trashDeletions,
    });
  } catch (err) {
    console.error("[GET /api/sync/obsidian]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/sync/obsidian — trigger a sync run
export async function POST(request: NextRequest) {
  const apiAuth = await requireApiKey(request);
  const session = await getServerSession(authOptions);

  if (!apiAuth.authorized && !session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Require ADMIN for production use; allow WRITE for development
  if (apiAuth.authorized) {
    if (apiAuth.permissions !== "ADMIN" && apiAuth.permissions !== "WRITE") {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }
  } else {
    const role = (session?.user as { role?: string }).role;
    if (role !== "ADMIN") {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }
  }

  // Check feature flag
  try {
    const config = getObsidianSyncConfig();
    if (!config) {
      return NextResponse.json(
        { error: "Obsidian sync is not enabled. Set OBSIDIAN_SYNC_ENABLED=true" },
        { status: 400 }
      );
    }
  } catch (err) {
    return NextResponse.json(
      { error: `Configuration error: ${(err as Error).message}` },
      { status: 400 }
    );
  }

  // Parse request body
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const mode = body["mode"] === "full" || body["full"] === true ? "full" : "incremental";
  const articleIds = Array.isArray(body["articleIds"])
    ? (body["articleIds"] as string[])
    : undefined;
  const topicIds = Array.isArray(body["topicIds"])
    ? (body["topicIds"] as string[])
    : undefined;
  const clean =
    body["clean"] === undefined ? true : body["clean"] === true;
  const git =
    body["git"] === undefined ? false : body["git"] === true;
  const dryRun =
    body["dryRun"] === undefined ? false : body["dryRun"] === true;

  // Validate: cannot use articleIds/topicIds together with full rebuild on large sets
  if (mode === "full" && (articleIds || topicIds)) {
    return NextResponse.json(
      { error: "Cannot specify articleIds/topicIds with mode=full" },
      { status: 400 }
    );
  }

  const callerName = session?.user?.name ?? (apiAuth.authorized ? "API Key" : undefined);

  const options: SyncOptions = {
    mode,
    articleIds,
    topicIds,
    clean,
    git,
    dryRun,
    callerName,
  };

  try {
    const result = await runObsidianSync(options);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof SyncConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("[POST /api/sync/obsidian]", err);
    return NextResponse.json(
      { error: `Sync failed: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
