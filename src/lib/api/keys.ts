import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import type { Permissions, Prisma } from "@prisma/client";

const ALGORITHM = "sha256";
const KEY_PREFIX_LENGTH = 8;

/** How long to wait before re-recording a lastUsedAt timestamp (5 minutes). */
const LAST_USED_DEBOUNCE_MS = 5 * 60 * 1000;

export type ApiKeyValidationRecord = {
  id: string;
  permissions: Permissions;
  allowedScopes: string[];
  revokedAt: Date | null;
};

export type ApiKeyValidationClient = {
  findUnique(args: Prisma.ApiKeyFindUniqueArgs): Promise<ApiKeyValidationRecord | null>;
  updateMany(args: Prisma.ApiKeyUpdateManyArgs): Promise<Prisma.BatchPayload>;
};

/**
 * Hash an API key for storage.
 * Never store the raw key — only store the hash.
 */
export function hashApiKey(key: string): string {
  return crypto.createHash(ALGORITHM).update(key).digest("hex");
}

/**
 * Generate a new API key and return { raw, hash, prefix }.
 * Show the raw key ONCE — store only the hash.
 */
export function generateApiKey(_name: string): {
  raw: string;
  hash: string;
  prefix: string;
} {
  void _name; // Stored by caller; not needed in this function's implementation
  // Format: noo_<base64url_random_32_bytes>
  const randomBytes = crypto.randomBytes(32).toString("base64url");
  const raw = `noo_${randomBytes}`;
  const hash = hashApiKey(raw);
  const prefix = raw.slice(0, KEY_PREFIX_LENGTH);

  return { raw, hash, prefix };
}

/**
 * Validate an API key and return the ApiKey record if valid.
 * Updates lastUsedAt on successful validation.
 */
export async function validateApiKey(
  rawKey: string,
  apiKeys: ApiKeyValidationClient = prisma.apiKey,
): Promise<
  | { valid: true; permissions: Permissions; keyId: string; allowedScopes: string[] }
  | { valid: false }
> {
  const hash = hashApiKey(rawKey);

  // This is a normal indexed DB lookup, not a constant-time secret comparison.
  // Missing and revoked keys are still collapsed to the same invalid response below.
  const record = await apiKeys.findUnique({
    where: { keyHash: hash },
  });

  if (!record || record.revokedAt !== null) {
    return { valid: false };
  }

  // Update last-used timestamp atomically and at most once per debounce window.
  const now = new Date();
  const cutoff = new Date(now.getTime() - LAST_USED_DEBOUNCE_MS);
  await apiKeys.updateMany({
    where: {
      id: record.id,
      OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: cutoff } }],
    },
    data: { lastUsedAt: now },
  });

  return {
    valid: true,
    permissions: record.permissions,
    keyId: record.id,
    allowedScopes: record.allowedScopes,
  };
}

/**
 * Middleware-style helper for Next.js API routes.
 * Reads the API key from the Authorization header.
 * Usage:
 *   const auth = await requireApiKey(req);
 *   if (!auth.authorized) return res.status(401).json({ error: "Invalid API key" });
 */
export async function requireApiKey(
  request: Request
): Promise<
  | { authorized: true; permissions: Permissions; keyId: string; allowedScopes: string[] }
  | { authorized: false }
> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { authorized: false };
  }

  const rawKey = authHeader.slice("Bearer ".length).trim();
  if (!rawKey) {
    return { authorized: false };
  }

  const result = await validateApiKey(rawKey);
  if (!result.valid) return { authorized: false };
  return {
    authorized: true,
    permissions: result.permissions,
    keyId: result.keyId,
    allowedScopes: result.allowedScopes,
  };
}
