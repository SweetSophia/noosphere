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
import { requirePermission } from "@/lib/api/auth";
import { getObsidianSyncConfig } from "@/lib/obsidian-sync/config";
import { rateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { loadManifest } from "@/lib/markdown-sync/manifest";
import {
  applyMarkdownImports,
  MARKDOWN_IMPORT_APPLY_PERMISSIONS,
} from "@/lib/markdown-sync/import-applier";
import {
  scanMarkdownImportCandidates,
  MarkdownImportScanLimitError,
  validateMarkdownImportScanRequestBody,
} from "@/lib/markdown-sync/import-scanner";
import {
  parseMarkdownImportCandidateIds,
  selectMarkdownImportCandidatesByQueryIds,
} from "@/lib/markdown-sync/import-workflow";

const PREVIEW_RATE_LIMIT = { windowMs: 60_000, maxRequests: 10, keyPrefix: "sync-import-apply-preview" };

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
  const candidateIdsParams = searchParams.getAll("candidateIds");
  const mode = (searchParams.get("mode") ?? "upsert") as "create" | "update" | "upsert";
  const forceOverwrite = searchParams.get("forceOverwrite") === "true";

  if (candidateIdsParams.length === 0) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Missing 'candidateIds' query parameter. Use repeated candidateIds for multiple paths " +
          "(e.g. ?candidateIds=a.md&candidateIds=b.md) or a single comma-separated list for backwards compatibility. " +
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

  const candidateIdsResult = parseMarkdownImportCandidateIds(candidateIdsParams);
  if (!candidateIdsResult.ok) {
    return NextResponse.json({ success: false, error: candidateIdsResult.error }, { status: 400 });
  }

  const scanOptions = parseScanOptions(searchParams);
  if (!scanOptions.ok) {
    return NextResponse.json({ success: false, error: scanOptions.error }, { status: 400 });
  }

  const scanValidation = validateMarkdownImportScanRequestBody(scanOptions.options);
  if ("errors" in scanValidation) {
    return NextResponse.json({ success: false, error: scanValidation.errors.join("; ") }, { status: 400 });
  }

  // ── Load vault config ─────────────────────────────────────────────────────
  let config;
  try {
    config = getObsidianSyncConfig();
  } catch (err) {
    console.error("[import-apply-preview] Obsidian sync configuration error:", err);
    return NextResponse.json(
      { success: false, error: "Obsidian sync configuration error." },
      { status: 500 }
    );
  }
  if (!config) {
    return NextResponse.json(
      { success: false, error: "Obsidian sync is not enabled. Set OBSIDIAN_SYNC_ENABLED and OBSIDIAN_SYNC_VAULT_PATH." },
      { status: 503 }
    );
  }

  // ── Load manifest ─────────────────────────────────────────────────────────
  const manifest = loadManifest(config.vaultPath, config.manifestPath);
  if (!manifest) {
    return NextResponse.json(
      { success: false, error: "Manifest missing or invalid. Ensure the vault has been synced with POST /api/sync/obsidian." },
      { status: 400 }
    );
  }

  // ── Preview apply (dry-run) ──────────────────────────────────────────────
  const performedBy = auth.auth.name ?? auth.auth.keyId ?? auth.auth.userId ?? "system";

  try {
    // ── Run full scan to get fresh candidate data ─────────────────────────────
    const scanResult = scanMarkdownImportCandidates({
      vaultPath: config.vaultPath,
      manifestPath: config.manifestPath,
      includeUntracked: scanValidation.includeUntracked,
      maxFiles: scanValidation.maxFiles,
    });

    // Filter to only the requested candidate IDs. Exact query values win first so
    // vault paths containing commas are preserved; legacy comma-list parsing is
    // only used if a single exact value matches nothing.
    const selection = selectMarkdownImportCandidatesByQueryIds(scanResult.candidates, candidateIdsParams);

    if (selection.candidates.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: "None of the specified candidate IDs were found in the current scan.",
          notFound: selection.notFound,
        },
        { status: 404 }
      );
    }

    const result = await applyMarkdownImports(prisma, {
      vaultPath: config.vaultPath,
      manifest,
      config,
      candidates: selection.candidates,
      mode,
      forceOverwrite,
      dryRun: true,
      performedBy,
    });

    return NextResponse.json({
      ...result,
      notFound: selection.notFound.length > 0 ? selection.notFound : undefined,
    });
  } catch (err) {
    if (err instanceof MarkdownImportScanLimitError) {
      return NextResponse.json(
        { success: false, error: err.message },
        { status: 413 }
      );
    }
    console.error("[import-apply-preview] Error running preview:", err);
    return NextResponse.json(
      { success: false, error: "Internal error during preview." },
      { status: 500 }
    );
  }
}

type PreviewScanOptionsParseResult =
  | { ok: true; options: Record<string, unknown> }
  | { ok: false; error: string };

function parseScanOptions(searchParams: URLSearchParams): PreviewScanOptionsParseResult {
  const options: Record<string, unknown> = {};

  const includeUntracked = searchParams.get("includeUntracked");
  if (includeUntracked !== null) {
    if (includeUntracked !== "true" && includeUntracked !== "false") {
      return { ok: false, error: 'includeUntracked must be "true" or "false" when provided.' };
    }
    options.includeUntracked = includeUntracked === "true";
  }

  const maxFiles = searchParams.get("maxFiles");
  if (maxFiles !== null) {
    if (!/^[1-9]\d*$/.test(maxFiles)) {
      return { ok: false, error: "maxFiles must be an integer between 1 and 50000." };
    }
    options.maxFiles = Number(maxFiles);
  }

  return { ok: true, options };
}
