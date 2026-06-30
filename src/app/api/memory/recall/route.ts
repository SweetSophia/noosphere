import { NextRequest, NextResponse } from "next/server";
import { Permissions } from "@prisma/client";
import { requirePermission } from "@/lib/api/auth";
import { readBoundedJson, RequestBodyTooLargeError, JsonDepthExceededError } from "@/lib/api/body";
import { executeMemoryRecallRequest } from "@/lib/memory/api/recall";
import { rateLimit } from "@/lib/rate-limit";

export const MEMORY_RECALL_RATE_LIMIT_ENV = "NOOSPHERE_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE";

export const DEFAULT_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE = 120;

const warnedInvalidEnvValues = new Set<string>();

export function getMemoryRecallRateLimitOptions() {
  return {
    windowMs: 60_000,
    maxRequests: readPositiveIntegerEnv(
      MEMORY_RECALL_RATE_LIMIT_ENV,
      DEFAULT_MEMORY_RECALL_RATE_LIMIT_PER_MINUTE,
    ),
    keyPrefix: "memory-recall",
  };
}

export async function POST(request: NextRequest) {
  const rl = await rateLimit(request, getMemoryRecallRateLimitOptions());
  if (!rl.allowed) return rl.response;

  const auth = await requirePermission(request, [Permissions.READ]);
  if (!auth.success) {
    return auth.response;
  }

  let body: unknown;
  try {
    body = await readBoundedJson(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError || error instanceof JsonDepthExceededError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const result = await executeMemoryRecallRequest(body, {
      allowedScopes: auth.auth.allowedScopes,
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error("[POST /api/memory/recall]", error);
    return NextResponse.json(
      { error: "Memory recall unavailable" },
      { status: 503 },
    );
  }
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || !/^\d+$/.test(value)) {
    if (value !== undefined) {
      warnInvalidEnvValueOnce(name, value, fallback);
    }
    return fallback;
  }

  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) && parsed > 0) {
    return parsed;
  }

  warnInvalidEnvValueOnce(name, value, fallback);
  return fallback;
}

function warnInvalidEnvValueOnce(name: string, value: string, fallback: number) {
  const key = `${name}\0${value}`;
  if (warnedInvalidEnvValues.has(key)) {
    return;
  }

  warnedInvalidEnvValues.add(key);
  console.warn(
    `[memory-recall] Ignoring invalid ${name}=${JSON.stringify(value)}; using ${fallback}`,
  );
}
