/**
 * SyncConflictPreferences persistence helpers.
 *
 * Stores one normalized row with id="singleton". The API exposes only the
 * public settings shape and does not leak internal database identifiers.
 */

import {
  DEFAULT_SYNC_CONFLICT_PREFERENCES,
  normalizeSyncConflictPreferences,
  toPublicSyncConflictPreferences,
  type PublicSyncConflictPreferences,
  type SyncConflictBehavior,
  type SyncConflictPreferences,
  type SyncConflictPreferencesUpdate,
} from "@/lib/markdown-sync/conflict-preferences";

interface SyncConflictPreferencesRow {
  id: string;
  defaultBehavior: string;
  noosphereToVault: string;
  vaultToNoosphere: string;
  updatedAt: Date;
}

function rowToSyncConflictPreferences(row: SyncConflictPreferencesRow | null): SyncConflictPreferences | null {
  if (!row) return null;

  return normalizeSyncConflictPreferences({
    defaultBehavior: row.defaultBehavior as SyncConflictBehavior,
    directionPreferences: {
      "noosphere-to-vault": row.noosphereToVault as SyncConflictBehavior,
      "vault-to-noosphere": row.vaultToNoosphere as SyncConflictBehavior,
    },
  });
}

export async function getSyncConflictPreferencesFromDB(): Promise<PublicSyncConflictPreferences> {
  const { prisma } = await import("@/lib/prisma");

  const row = await prisma.syncConflictPreferences.findUnique({
    where: { id: "singleton" },
  });

  const preferences = rowToSyncConflictPreferences(row) ?? { ...DEFAULT_SYNC_CONFLICT_PREFERENCES };
  return toPublicSyncConflictPreferences(preferences, row?.updatedAt ?? null);
}

export async function upsertSyncConflictPreferences(
  updates: SyncConflictPreferencesUpdate,
): Promise<PublicSyncConflictPreferences> {
  const { prisma } = await import("@/lib/prisma");

  const updateData: {
    defaultBehavior?: SyncConflictBehavior;
    noosphereToVault?: SyncConflictBehavior;
    vaultToNoosphere?: SyncConflictBehavior;
    updatedAt?: Date;
  } = {};

  if (updates.defaultBehavior !== undefined) {
    updateData.defaultBehavior = updates.defaultBehavior;
  }
  if (updates.directionPreferences?.["noosphere-to-vault"] !== undefined) {
    updateData.noosphereToVault = updates.directionPreferences["noosphere-to-vault"];
  }
  if (updates.directionPreferences?.["vault-to-noosphere"] !== undefined) {
    updateData.vaultToNoosphere = updates.directionPreferences["vault-to-noosphere"];
  }

  if (Object.keys(updateData).length === 0) {
    return getSyncConflictPreferencesFromDB();
  }

  updateData.updatedAt = new Date();

  const row = await prisma.syncConflictPreferences.upsert({
    where: { id: "singleton" },
    update: updateData,
    create: {
      id: "singleton",
      defaultBehavior: updates.defaultBehavior ?? DEFAULT_SYNC_CONFLICT_PREFERENCES.defaultBehavior,
      noosphereToVault:
        updates.directionPreferences?.["noosphere-to-vault"] ??
        DEFAULT_SYNC_CONFLICT_PREFERENCES.directionPreferences["noosphere-to-vault"],
      vaultToNoosphere:
        updates.directionPreferences?.["vault-to-noosphere"] ??
        DEFAULT_SYNC_CONFLICT_PREFERENCES.directionPreferences["vault-to-noosphere"],
      updatedAt: updateData.updatedAt,
    },
  });

  const preferences = rowToSyncConflictPreferences(row) ?? { ...DEFAULT_SYNC_CONFLICT_PREFERENCES };
  return toPublicSyncConflictPreferences(preferences, row.updatedAt);
}
