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
import { requirePermission } from "@/lib/api/auth";
import { getObsidianSyncConfig } from "@/lib/obsidian-sync/config";
import { rateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { loadManifest } from "@/lib/markdown-sync/manifest";
import {
  applyMarkdownImports,
  MARKDOWN_IMPORT_APPLY_MAX_BODY_BYTES,
  MARKDOWN_IMPORT_APPLY_PERMISSIONS,
} from "@/lib/markdown-sync/import-applier";
import {
  MarkdownImportScanLimitError,
  scanMarkdownImportCandidates,
  validateMarkdownImportScanRequestBody,
} from "@/lib/markdown-sync/import-scanner";
import {
  parseMarkdownImportCandidateIds,
  selectMarkdownImportCandidatesById,
  validateMarkdownImportCandidates,
} from "@/lib/markdown-sync/import-workflow";
import type { MarkdownImportCandidate } from "@/lib/markdown-sync/import-scanner";

const IMPORT_APPLY_RATE_LIMIT = { windowMs: 60_000, maxRequests: 5, keyPrefix: "sync-import-apply-post" };

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
    if (Buffer.byteLength(rawBody, "utf-8") > MARKDOWN_IMPORT_APPLY_MAX_BODY_BYTES) {
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
  const hasCandidates = Array.isArray(body.candidates) && body.candidates.length > 0;
  const hasCandidateIds = body.candidateIds !== undefined;
  if (!hasCandidates && !hasCandidateIds) {
    return NextResponse.json(
      { success: false, error: "Provide either a non-empty 'candidates' array or 'candidateIds'." },
      { status: 400 }
    );
  }

  if (hasCandidates && hasCandidateIds) {
    return NextResponse.json(
      { success: false, error: "Provide either 'candidates' or 'candidateIds', not both." },
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
  let config;
  try {
    config = getObsidianSyncConfig();
  } catch (err) {
    console.error("[import-apply] Obsidian sync configuration error:", err);
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

  // ── Resolve candidates ───────────────────────────────────────────────────
  let candidates: MarkdownImportCandidate[];
  let notFound: string[] = [];
  if (hasCandidateIds) {
    const candidateIdsResult = parseMarkdownImportCandidateIds(body.candidateIds);
    if (!candidateIdsResult.ok) {
      return NextResponse.json({ success: false, error: candidateIdsResult.error }, { status: 400 });
    }

    const scanValidation = validateMarkdownImportScanRequestBody({
      includeUntracked: body.includeUntracked,
      maxFiles: body.maxFiles,
    });
    if ("errors" in scanValidation) {
      return NextResponse.json({ success: false, error: scanValidation.errors.join("; ") }, { status: 400 });
    }

    try {
      const scanResult = scanMarkdownImportCandidates({
        vaultPath: config.vaultPath,
        manifestPath: config.manifestPath,
        includeUntracked: scanValidation.includeUntracked,
        maxFiles: scanValidation.maxFiles,
      });
      const selection = selectMarkdownImportCandidatesById(scanResult.candidates, candidateIdsResult.candidateIds);
      candidates = selection.candidates;
      notFound = selection.notFound;
    } catch (err) {
      if (err instanceof MarkdownImportScanLimitError) {
        return NextResponse.json({ success: false, error: err.message }, { status: 413 });
      }
      console.error("[import-apply] Error scanning candidates:", err);
      return NextResponse.json(
        { success: false, error: "Failed to scan markdown import candidates." },
        { status: 503 }
      );
    }

    if (candidates.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: "None of the specified candidate IDs were found in the current scan.",
          notFound,
        },
        { status: 404 }
      );
    }
  } else {
    const candidatesValidation = validateMarkdownImportCandidates(body.candidates);
    if (!candidatesValidation.ok) {
      return NextResponse.json({ success: false, error: candidatesValidation.error }, { status: 400 });
    }
    candidates = candidatesValidation.candidates;
  }

  // ── Apply imports ────────────────────────────────────────────────────────
  const performedBy = auth.auth.name ?? auth.auth.keyId ?? auth.auth.userId ?? "system";

  try {
    const result = await applyMarkdownImports(prisma, {
      vaultPath: config.vaultPath,
      manifest,
      config,
      candidates,
      mode: body.mode,
      forceOverwrite: body.forceOverwrite ?? false,
      dryRun: body.dryRun ?? false,
      performedBy,
    });

    return NextResponse.json(
      {
        ...result,
        notFound: notFound.length > 0 ? notFound : undefined,
      },
      { status: result.success ? 200 : 500 }
    );
  } catch (err) {
    console.error("[import-apply] Error applying imports:", err);
    return NextResponse.json(
      { success: false, error: "Internal error during import." },
      { status: 500 }
    );
  }
}

interface ImportApplyRequestBody {
  candidates?: unknown;
  candidateIds?: unknown;
  mode: "create" | "update" | "upsert";
  forceOverwrite?: boolean;
  dryRun?: boolean;
  includeUntracked?: unknown;
  maxFiles?: unknown;
}
