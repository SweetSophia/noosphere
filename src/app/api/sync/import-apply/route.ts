/**
 * POST /api/sync/import-apply
 *
 * Applies vault-side markdown changes back into Noosphere DB.
 * This is a write-capable admin endpoint with tight security.
 *
 * Phase 5 of the obsidian sync pipeline.
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { requirePermission } from "@/lib/api/auth";
import { getObsidianSyncConfig } from "@/lib/obsidian-sync/config";
import { rateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import {
  applyMarkdownImports,
  MARKDOWN_IMPORT_APPLY_MAX_BODY_BYTES,
  MARKDOWN_IMPORT_APPLY_PERMISSIONS,
} from "@/lib/markdown-sync/import-applier";
import type { Manifest } from "@/lib/obsidian-sync";
import type { MarkdownImportCandidate } from "@/lib/markdown-sync/import-scanner";

const IMPORT_APPLY_RATE_LIMIT = { windowMs: 60_000, maxRequests: 5, keyPrefix: "sync-import-apply-post" };

/**
 * Load and validate a manifest from the vault.
 */
function loadManifest(vaultPath: string, manifestRelPath: string): Manifest | null {
  const manifestAbsPath = resolve(vaultPath, manifestRelPath);
  if (!existsSync(manifestAbsPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestAbsPath, "utf-8")) as Manifest;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  // ── Rate Limiting (ADMIN only, 5/min) ───────────────────────────────────
  const rl = await rateLimit(request, IMPORT_APPLY_RATE_LIMIT);
  if (!rl.allowed) return rl.response;

  // ── Auth Check ────────────────────────────────────────────────────────────
  const auth = await requirePermission(request, [...MARKDOWN_IMPORT_APPLY_PERMISSIONS]);
  if (!auth.success) {
    return auth.response;
  }

  // ── Parse request body ───────────────────────────────────────────────────
  let body: ImportApplyRequestBody;
  try {
    const rawBody = await request.text();
    if (rawBody.length > MARKDOWN_IMPORT_APPLY_MAX_BODY_BYTES) {
      return NextResponse.json(
        { success: false, error: "Request body too large." },
        { status: 413 }
      );
    }
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  // ── Validate request body ─────────────────────────────────────────────────
  if (!body.candidates || !Array.isArray(body.candidates) || body.candidates.length === 0) {
    return NextResponse.json(
      { success: false, error: "Missing or empty 'candidates' array." },
      { status: 400 }
    );
  }

  if (!["create", "update", "upsert"].includes(body.mode)) {
    return NextResponse.json(
      { success: false, error: "Invalid 'mode'. Must be 'create', 'update', or 'upsert'." },
      { status: 400 }
    );
  }

  // ── Load vault config ─────────────────────────────────────────────────────
  const config = getObsidianSyncConfig();
  if (!config) {
    return NextResponse.json(
      { success: false, error: "Obsidian sync is not enabled. Set OBSIDIAN_SYNC_ENABLED and OBSIDIAN_SYNC_VAULT_PATH." },
      { status: 500 }
    );
  }

  // ── Load manifest ─────────────────────────────────────────────────────────
  const manifest = loadManifest(config.vaultPath, config.manifestPath);
  if (!manifest) {
    return NextResponse.json(
      { success: false, error: "Manifest not found. Run POST /api/sync/obsidian first." },
      { status: 400 }
    );
  }

  // ── Apply imports ────────────────────────────────────────────────────────
  const performedBy = auth.auth.name ?? auth.auth.keyId ?? auth.auth.userId ?? "system";

  try {
    const result = await applyMarkdownImports(prisma, {
      vaultPath: config.vaultPath,
      manifest,
      candidates: body.candidates as MarkdownImportCandidate[],
      mode: body.mode,
      forceOverwrite: body.forceOverwrite ?? false,
      dryRun: body.dryRun ?? false,
      performedBy,
    });

    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (err) {
    console.error("[import-apply] Error applying imports:", err);
    return NextResponse.json(
      { success: false, error: "Internal error during import.", detail: String(err) },
      { status: 500 }
    );
  }
}

interface ImportApplyRequestBody {
  candidates: unknown;
  mode: "create" | "update" | "upsert";
  forceOverwrite?: boolean;
  dryRun?: boolean;
}
