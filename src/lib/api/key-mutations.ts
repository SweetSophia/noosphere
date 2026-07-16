import { Permissions, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { generateApiKey } from "./keys";
import { MemoryCaptureError, withSerializableRetry } from "@/lib/memory/capture/repository";

const API_KEY_METADATA_SELECT = {
  id: true,
  name: true,
  keyPrefix: true,
  permissions: true,
  allowedScopes: true,
  agentPrincipalId: true,
  createdAt: true,
  lastUsedAt: true,
  revokedAt: true,
} satisfies Prisma.ApiKeySelect;

export type ApiKeyCreationInput = {
  name: string;
  permissions: Permissions;
  allowedScopes: string[];
  agentPrincipalId?: string | null;
};

export async function createApiKeyRecord(input: ApiKeyCreationInput) {
  const generated = generateApiKey(input.name);
  const key = await withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockAllowedScopes(tx, input.allowedScopes);
        await validatePrincipalBinding(tx, input);
        return tx.apiKey.create({
          data: {
            name: input.name,
            keyHash: generated.hash,
            keyPrefix: generated.prefix,
            permissions: input.permissions,
            allowedScopes: input.allowedScopes,
            agentPrincipalId: input.agentPrincipalId ?? null,
          },
          select: API_KEY_METADATA_SELECT,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  return { key, raw: generated.raw };
}

export async function updateApiKeyRecord(
  id: string,
  data: { name?: string; permissions?: Permissions; allowedScopes?: string[] },
) {
  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const snapshot = await tx.apiKey.findUnique({
          where: { id },
          select: { allowedScopes: true },
        });
        if (!snapshot) throw new MemoryCaptureError("API key not found", 404);
        await lockAllowedScopes(
          tx,
          data.allowedScopes ?? snapshot.allowedScopes,
        );
        const current = await lockApiKey(tx, id);
        if (current.revokedAt) throw new MemoryCaptureError("API key not found", 404);
        const next = {
          name: data.name ?? current.name,
          permissions: data.permissions ?? current.permissions,
          allowedScopes: data.allowedScopes ?? current.allowedScopes,
          agentPrincipalId: current.agentPrincipalId,
        };
        await validatePrincipalBinding(tx, next);
        return tx.apiKey.update({
          where: { id },
          data,
          select: API_KEY_METADATA_SELECT,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function revokeApiKeyCredential(id: string): Promise<void> {
  await withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const snapshot = await tx.apiKey.findUnique({
          where: { id },
          select: { allowedScopes: true },
        });
        if (!snapshot) throw new MemoryCaptureError("API key not found", 404);
        await lockAllowedScopes(tx, snapshot.allowedScopes);
        const current = await lockApiKey(tx, id);
        if (current.revokedAt) throw new MemoryCaptureError("API key not found", 404);
        await tx.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function rotateApiKeyCredential(id: string) {
  const rotated = await withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const current = await lockApiKey(tx, id);
        if (current.revokedAt) {
          throw new MemoryCaptureError("Cannot rotate a revoked key", 409);
        }
        await validatePrincipalBinding(tx, current);
        const rotatedName = current.name.includes(" (rotated)")
          ? current.name
          : `${current.name} (rotated)`;
        const generated = generateApiKey(rotatedName);
        const created = await tx.apiKey.create({
          data: {
            name: rotatedName,
            keyHash: generated.hash,
            keyPrefix: generated.prefix,
            permissions: current.permissions,
            allowedScopes: current.allowedScopes,
            agentPrincipalId: current.agentPrincipalId,
          },
          select: API_KEY_METADATA_SELECT,
        });
        // Credential invalidation is not a privacy-lineage revocation. Existing
        // captures remain attached to the unchanged principal.
        await tx.apiKey.update({
          where: { id },
          data: { revokedAt: new Date() },
        });
        return { key: created, raw: generated.raw };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  return rotated;
}

export async function deleteRevokedApiKey(id: string): Promise<void> {
  await withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const current = await lockApiKey(tx, id);
        if (!current.revokedAt) {
          throw new MemoryCaptureError("Only revoked keys can be deleted", 409);
        }
        await tx.apiKey.delete({ where: { id } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

async function validatePrincipalBinding(
  tx: Prisma.TransactionClient,
  input: {
    permissions: Permissions;
    allowedScopes: string[];
    agentPrincipalId?: string | null;
  },
): Promise<void> {
  if (!input.agentPrincipalId) return;
  const principalRows = await tx.$queryRaw<
    Array<{
      id: string;
      privateScopeTag: string;
      status: "ACTIVE" | "REVOKED";
      revokedAt: Date | null;
    }>
  >(Prisma.sql`
    SELECT "id", "privateScopeTag", "status", "revokedAt"
    FROM "MemoryAgentPrincipal"
    WHERE "id" = ${input.agentPrincipalId}
    FOR KEY SHARE
  `);
  const principal = principalRows[0];
  if (!principal || principal.status !== "ACTIVE" || principal.revokedAt) {
    throw new MemoryCaptureError("Memory principal is unavailable", 400);
  }
  if (input.permissions !== Permissions.WRITE && input.permissions !== Permissions.ADMIN) {
    throw new MemoryCaptureError("Principal-bound keys require WRITE or ADMIN", 400);
  }
  if (!input.allowedScopes.includes(principal.privateScopeTag)) {
    throw new MemoryCaptureError(
      "Principal-bound keys must explicitly include the principal private scope",
      400,
    );
  }
}

async function lockAllowedScopes(
  tx: Prisma.TransactionClient,
  allowedScopes: string[],
): Promise<void> {
  const concreteScopes = [...new Set(allowedScopes.filter((tag) => tag !== "*"))]
    .sort();
  if (concreteScopes.length === 0) return;

  const rows = await tx.$queryRaw<Array<{ tag: string }>>(Prisma.sql`
    SELECT "tag"
    FROM "RestrictedScope"
    WHERE "tag" IN (${Prisma.join(concreteScopes)})
    ORDER BY "tag"
    FOR KEY SHARE
  `);
  const found = new Set(rows.map(({ tag }) => tag));
  const missing = concreteScopes.filter((tag) => !found.has(tag));
  if (missing.length > 0) {
    throw new MemoryCaptureError(
      `Unknown scope(s): ${missing.join(", ")}`,
      400,
    );
  }
}

async function lockApiKey(tx: Prisma.TransactionClient, id: string) {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      name: string;
      permissions: Permissions;
      allowedScopes: string[];
      agentPrincipalId: string | null;
      revokedAt: Date | null;
    }>
  >(Prisma.sql`
    SELECT "id", "name", "permissions", "allowedScopes",
           "agentPrincipalId", "revokedAt"
    FROM "ApiKey"
    WHERE "id" = ${id}
    FOR UPDATE
  `);
  const key = rows[0];
  if (!key) throw new MemoryCaptureError("API key not found", 404);
  return key;
}
