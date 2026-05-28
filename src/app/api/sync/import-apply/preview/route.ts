/**
 * GET /api/sync/import-apply/preview
 *
 * Preview what would happen if we applied certain candidates from the import scan.
 * This is a read-only simulation — it never writes to the DB.
 *
 * Requires ADMIN permission (same as the apply endpoint).
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { requirePermission } from "@/lib/api/auth";
import { getObsidianSyncConfig } from "@/lib/obsidian-sync/config";
import { rateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import {
  applyMarkdownImports,
  MARKDOWN_IMPORT_APPLY_PERMISSIONS,
} from "@/lib/markdown-sync/import-applier";
import { scanMarkdownImportCandidates } from "@/lib/markdown-sync/import-scanner";
import type { Manifest } from "@/lib/obsidian-sync";
import type { MarkdownImportCandidate } from "@/lib/markdown-sync/import-scanner";

const PREVIEW_RATE_LIMIT = { windowMs: 60_000, maxRequests: 10, keyPrefix: "sync-import-apply-preview" };

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

export async function GET(request: NextRequest) {
  // ── Rate Limiting (ADMIN only, 10/min) ──────────────────────────────────
  const rl = await rateLimit(request, PREVIEW_RATE_LIMIT);
  if (!rl.allowed) return rl.response;

  // ── Auth Check ────────────────────────────────────────────────────────────
  const auth = await requirePermission(request, [...MARKDOWN_IMPORT_APPLY_PERMISSIONS]);
  if (!auth.success) {
    return auth.response;
  }

  // ── Parse query parameters ─────────────────────────────────────────────────
  const searchParams = request.nextUrl.searchParams;
  const candidateIdsParam = searchParams.get("candidateIds");
  const mode = (searchParams.get("mode") ?? "upsert") as "create" | "update" | "upsert";
  const forceOverwrite = searchParams.get("forceOverwrite") === "true";

  if (!candidateIdsParam) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Missing 'candidateIds' query parameter (comma-separated list of relative paths). " +
          "Run POST /api/sync/import-scan first to get candidates.",
      },
      { status: 400 }
    );
  }

  if (!["create", "update", "upsert"].includes(mode)) {
    return NextResponse.json(
      { success: false, error: "Invalid 'mode'. Must be 'create', 'update', or 'upsert'." },
      { status: 400 }
    );
  }

  const candidateIds = candidateIdsParam.split(",").map((id) => id.trim()).filter(Boolean);
  if (candidateIds.length === 0) {
    return NextResponse.json({ success: false, error: "Empty 'candidateIds'." }, { status: 400 });
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

  // ── Run full scan to get fresh candidate data ─────────────────────────────
  // Note: scanMarkdownImportCandidates returns MarkdownImportScanResult with success: true.
  // If it fails, it throws an exception (e.g., MarkdownImportScanLimitError).
  // The try-catch below handles this.
  const scanResult = scanMarkdownImportCandidates({
    vaultPath: config.vaultPath,
    manifestPath: config.manifestPath,
    includeUntracked: true,
    maxFiles: 5_000,
  });

  // Filter to only the requested candidate IDs
  const requestedCandidates: MarkdownImportCandidate[] = [];
  const notFound: string[] = [];

  for (const candidateId of candidateIds) {
    const candidate = scanResult.candidates.find((c) => c.relativePath === candidateId);
    if (candidate) {
      requestedCandidates.push(candidate);
    } else {
      notFound.push(candidateId);
    }
  }

  if (requestedCandidates.length === 0) {
    return NextResponse.json(
      {
        success: false,
        error: "None of the specified candidate IDs were found in the current scan.",
        notFound,
      },
      { status: 404 }
    );
  }

  // ── Preview apply (dry-run) ──────────────────────────────────────────────
  const performedBy = auth.auth.name ?? auth.auth.keyId ?? auth.auth.userId ?? "system";

  try {
    const result = await applyMarkdownImports(prisma, {
      vaultPath: config.vaultPath,
      manifest,
      config,
      candidates: requestedCandidates,
      mode,
      forceOverwrite,
      dryRun: true,
      performedBy,
    });

    return NextResponse.json({
      ...result,
      notFound: notFound.length > 0 ? notFound : undefined,
    });
  } catch (err) {
    console.error("[import-apply-preview] Error running preview:", err);
    return NextResponse.json(
      { success: false, error: "Internal error during preview.", detail: String(err) },
      { status: 500 }
    );
  }
}
