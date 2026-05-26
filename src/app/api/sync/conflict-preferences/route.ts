/**
 * GET/POST /api/sync/conflict-preferences
 *
 * Stores markdown sync conflict behavior preferences. Reads require READ so
 * agents can inspect safe config; writes require ADMIN because these defaults
 * can decide whether future sync flows preserve, overwrite, or queue conflicts.
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/auth";
import {
  getSyncConflictPreferencesFromDB,
  upsertSyncConflictPreferences,
} from "@/lib/markdown-sync/api/conflict-preferences";
import {
  SYNC_CONFLICT_PREFERENCES_MAX_BODY_BYTES,
  SYNC_CONFLICT_PREFERENCES_READ_PERMISSIONS,
  SYNC_CONFLICT_PREFERENCES_WRITE_PERMISSIONS,
  validateSyncConflictPreferencesContentLength,
  validateSyncConflictPreferencesUpdate,
} from "@/lib/markdown-sync/conflict-preferences";
import { rateLimit } from "@/lib/rate-limit";

export async function GET(request: NextRequest) {
  const rl = rateLimit(request, { windowMs: 60_000, maxRequests: 60, keyPrefix: "sync-conflict-preferences-get" });
  if (!rl.allowed) return rl.response;

  const auth = await requirePermission(request, [...SYNC_CONFLICT_PREFERENCES_READ_PERMISSIONS]);
  if (!auth.success) {
    return auth.response;
  }

  try {
    const preferences = await getSyncConflictPreferencesFromDB();
    return NextResponse.json(preferences, { status: 200 });
  } catch (error) {
    console.error("[GET /api/sync/conflict-preferences]", error);
    return NextResponse.json({ error: "Failed to retrieve conflict preferences" }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  const rl = rateLimit(request, { windowMs: 60_000, maxRequests: 30, keyPrefix: "sync-conflict-preferences-post" });
  if (!rl.allowed) return rl.response;

  const auth = await requirePermission(request, [...SYNC_CONFLICT_PREFERENCES_WRITE_PERMISSIONS]);
  if (!auth.success) {
    return auth.response;
  }

  const contentLengthValidation = validateSyncConflictPreferencesContentLength(request.headers.get("content-length"));
  if (!contentLengthValidation.ok) {
    return NextResponse.json({ error: contentLengthValidation.error }, { status: contentLengthValidation.status });
  }

  let body: unknown;
  try {
    const bodyText = await request.text();
    if (new TextEncoder().encode(bodyText).byteLength > SYNC_CONFLICT_PREFERENCES_MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: `Request body too large. Maximum size is ${SYNC_CONFLICT_PREFERENCES_MAX_BODY_BYTES} bytes.` },
        { status: 413 },
      );
    }
    body = JSON.parse(bodyText);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validation = validateSyncConflictPreferencesUpdate(body);
  if (!validation.ok) {
    return NextResponse.json({ error: `Invalid fields: ${validation.errors.join("; ")}` }, { status: 400 });
  }

  try {
    const updated = await upsertSyncConflictPreferences(validation.updates);
    return NextResponse.json(updated, { status: 200 });
  } catch (error) {
    console.error("[POST /api/sync/conflict-preferences]", error);
    return NextResponse.json({ error: "Failed to update conflict preferences" }, { status: 503 });
  }
}
