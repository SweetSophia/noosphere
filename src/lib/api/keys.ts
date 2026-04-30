import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import type { Permissions } from "@prisma/client";

const ALGORITHM = "sha256";
const KEY_PREFIX_LENGTH = 8;

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
  rawKey: string
): Promise<{ valid: true; permissions: Permissions; keyId: string } | { valid: false }> {
  const prefix = rawKey.slice(0, KEY_PREFIX_LENGTH);
  const hash = hashApiKey(rawKey);

  const record = await prisma.apiKey.findFirst({
    where: {
      keyPrefix: prefix,
      keyHash: hash,
      revokedAt: null,
    },
  });

  if (!record) {
    return { valid: false };
  }

  // Update last-used timestamp
  await prisma.apiKey.update({
    where: { id: record.id },
    data: { lastUsedAt: new Date() },
  });

  return { valid: true, permissions: record.permissions, keyId: record.id };
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
): Promise<{ authorized: true; permissions: Permissions; keyId: string } | { authorized: false }> {
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
  return { authorized: true, permissions: result.permissions, keyId: result.keyId };
}
