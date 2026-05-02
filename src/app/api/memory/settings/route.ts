import { NextRequest, NextResponse } from "next/server";
import { Permissions } from "@prisma/client";
import { requirePermission } from "@/lib/api/auth";
import { getRecallSettingsFromDB, upsertRecallSettings } from "@/lib/memory/api/settings";
import type { RecallSettings } from "@/lib/memory/settings";

// ─── Constants ───────────────────────────────────────────────────────────────

const SETTINGS_MAX_BODY_BYTES = 64 * 1024; // 64 KiB

// ─── GET /api/memory/settings ───────────────────────────────────────────────

/**
 * Return current RecallSettings from the database.
 * Merges with defaults for any missing fields.
 */
export async function GET(request: NextRequest) {
  const auth = await requirePermission(request, [Permissions.ADMIN]);
  if (!auth.success) {
    return auth.response;
  }

  try {
    const settings = await getRecallSettingsFromDB();
    return NextResponse.json(settings, { status: 200 });
  } catch (error) {
    console.error("[GET /api/memory/settings]", error);
    return NextResponse.json(
      { error: "Failed to retrieve settings" },
      { status: 503 },
    );
  }
}

// ─── POST /api/memory/settings ──────────────────────────────────────────────

/**
 * Update RecallSettings in the database.
 * Accepts partial settings and merges with existing values.
 */
export async function POST(request: NextRequest) {
  const auth = await requirePermission(request, [Permissions.ADMIN]);
  if (!auth.success) {
    return auth.response;
  }

  // Reject oversized bodies
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    parseInt(contentLength, 10) > SETTINGS_MAX_BODY_BYTES
  ) {
    return NextResponse.json(
      {
        error: `Request body too large. Maximum size is ${SETTINGS_MAX_BODY_BYTES} bytes.`,
      },
      { status: 413 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json(
      { error: "Body must be a JSON object" },
      { status: 400 },
    );
  }

  try {
    const updates = body as Partial<Record<string, unknown>>;

    // Basic field validation — normalizeRecallSettings handles clamping
    // Just reject obviously wrong types for top-level fields
    const invalidFields: string[] = [];

    for (const [key, value] of Object.entries(updates)) {
      switch (key) {
        case "autoRecallEnabled":
        case "summaryFirst":
          if (typeof value !== "boolean" && value !== undefined) {
            invalidFields.push(`${key} must be a boolean`);
          }
          break;
        case "maxInjectedMemories":
        case "maxInjectedTokens":
          if (typeof value !== "number" && value !== undefined) {
            invalidFields.push(`${key} must be a number`);
          }
          break;
        case "recallVerbosity":
        case "deduplicationStrategy":
        case "conflictStrategy":
          if (typeof value !== "string" && value !== undefined) {
            invalidFields.push(`${key} must be a string`);
          }
          break;
        case "enabledProviders":
          if (!Array.isArray(value) && value !== undefined) {
            invalidFields.push(`${key} must be an array`);
          }
          break;
        case "providerPriorityWeights":
          if (
            typeof value !== "object" &&
            value !== undefined &&
            !Array.isArray(value)
          ) {
            invalidFields.push(`${key} must be an object`);
          }
          break;
        case "conflictThreshold":
          if (typeof value !== "number" && value !== undefined) {
            invalidFields.push(`${key} must be a number`);
          }
          break;
      }
    }

    if (invalidFields.length > 0) {
      return NextResponse.json(
        { error: `Invalid fields: ${invalidFields.join("; ")}` },
        { status: 400 },
      );
    }

    const updated = await upsertRecallSettings(
      updates as Partial<RecallSettings>,
    );

    return NextResponse.json(updated, { status: 200 });
  } catch (error) {
    console.error("[POST /api/memory/settings]", error);
    return NextResponse.json(
      { error: "Failed to update settings" },
      { status: 503 },
    );
  }
}
