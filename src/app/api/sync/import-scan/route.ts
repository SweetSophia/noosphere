/**
 * POST /api/sync/import-scan
 *
 * Read-only reverse markdown import scanner. It reports vault-side markdown
 * candidates for later import/apply phases without changing DB or files.
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { Permissions } from "@prisma/client";
import { requirePermission } from "@/lib/api/auth";
import { getObsidianSyncConfig } from "@/lib/obsidian-sync/config";
import {
  MARKDOWN_IMPORT_SCAN_MAX_BODY_BYTES,
  MarkdownImportScanLimitError,
  scanMarkdownImportCandidates,
  validateMarkdownImportScanContentLength,
  validateMarkdownImportScanRequestBody,
} from "@/lib/markdown-sync/import-scanner";
import { rateLimit } from "@/lib/rate-limit";

export async function POST(request: NextRequest) {
  const rl = rateLimit(request, { windowMs: 60_000, maxRequests: 20, keyPrefix: "sync-import-scan-post" });
  if (!rl.allowed) return rl.response;

  const auth = await requirePermission(request, [Permissions.ADMIN]);
  if (!auth.success) {
    return auth.response;
  }

  const config = getObsidianSyncConfig();
  if (!config) {
    return NextResponse.json({ error: "Obsidian sync is not enabled" }, { status: 400 });
  }

  const contentLengthValidation = validateMarkdownImportScanContentLength(request.headers.get("content-length"));
  if (!contentLengthValidation.ok) {
    return NextResponse.json({ error: contentLengthValidation.error }, { status: contentLengthValidation.status });
  }

  let body: unknown = {};
  try {
    const bodyText = await request.text();
    if (bodyText.trim()) {
      if (new TextEncoder().encode(bodyText).byteLength > MARKDOWN_IMPORT_SCAN_MAX_BODY_BYTES) {
        return NextResponse.json(
          { error: `Request body too large. Maximum size is ${MARKDOWN_IMPORT_SCAN_MAX_BODY_BYTES} bytes.` },
          { status: 413 },
        );
      }
      body = JSON.parse(bodyText);
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validation = validateMarkdownImportScanRequestBody(body);
  if ("errors" in validation) {
    return NextResponse.json({ error: validation.errors.join("; ") }, { status: 400 });
  }

  try {
    const result = scanMarkdownImportCandidates({
      vaultPath: config.vaultPath,
      manifestPath: config.manifestPath,
      includeUntracked: validation.includeUntracked,
      maxFiles: validation.maxFiles,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof MarkdownImportScanLimitError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    console.error("[POST /api/sync/import-scan]", error);
    return NextResponse.json({ error: "Failed to scan markdown import candidates" }, { status: 503 });
  }
}
