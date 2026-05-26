/**
 * User-configurable markdown sync conflict preferences.
 *
 * These settings are intentionally narrower than the Obsidian environment
 * config. They describe what policy should be used when markdown and database
 * state diverge; later phases can consume the same normalized shape from the
 * forward sync, reverse scanner, and conflict review UI.
 */

import { Permissions } from "@prisma/client";

export const SYNC_CONFLICT_BEHAVIORS = ["preserve", "overwrite", "manual-review"] as const;
export type SyncConflictBehavior = (typeof SYNC_CONFLICT_BEHAVIORS)[number];

export const SYNC_CONFLICT_DIRECTIONS = ["noosphere-to-vault", "vault-to-noosphere"] as const;
export type SyncConflictDirection = (typeof SYNC_CONFLICT_DIRECTIONS)[number];

export const SYNC_CONFLICT_PREFERENCES_READ_PERMISSIONS = [Permissions.READ] as const;
export const SYNC_CONFLICT_PREFERENCES_WRITE_PERMISSIONS = [Permissions.ADMIN] as const;
export const SYNC_CONFLICT_PREFERENCES_MAX_BODY_BYTES = 64 * 1024;

export interface SyncConflictDirectionPreferences {
  "noosphere-to-vault": SyncConflictBehavior;
  "vault-to-noosphere": SyncConflictBehavior;
}

export interface SyncConflictPreferences {
  defaultBehavior: SyncConflictBehavior;
  directionPreferences: SyncConflictDirectionPreferences;
}

export interface PublicSyncConflictPreferences extends SyncConflictPreferences {
  updatedAt: string | null;
  allowedBehaviors: readonly SyncConflictBehavior[];
  allowedDirections: readonly SyncConflictDirection[];
}

export interface SyncConflictPreferencesUpdate {
  defaultBehavior?: SyncConflictBehavior;
  directionPreferences?: Partial<SyncConflictDirectionPreferences>;
}

export type SyncConflictPreferencesValidationResult =
  | { ok: true; updates: SyncConflictPreferencesUpdate }
  | { ok: false; errors: string[] };

export type ContentLengthValidationResult =
  | { ok: true }
  | { ok: false; status: 400 | 413; error: string };

export const DEFAULT_SYNC_CONFLICT_PREFERENCES: SyncConflictPreferences = {
  defaultBehavior: "manual-review",
  directionPreferences: {
    "noosphere-to-vault": "manual-review",
    "vault-to-noosphere": "manual-review",
  },
};

const VALID_BEHAVIORS = new Set<string>(SYNC_CONFLICT_BEHAVIORS);
const VALID_DIRECTIONS = new Set<string>(SYNC_CONFLICT_DIRECTIONS);
const ALLOWED_TOP_LEVEL_FIELDS = new Set(["defaultBehavior", "directionPreferences"]);

export function isSyncConflictBehavior(value: unknown): value is SyncConflictBehavior {
  return typeof value === "string" && VALID_BEHAVIORS.has(value);
}

export function normalizeSyncConflictPreferences(
  input: Partial<SyncConflictPreferences> = {},
): SyncConflictPreferences {
  const defaultBehavior = isSyncConflictBehavior(input.defaultBehavior)
    ? input.defaultBehavior
    : DEFAULT_SYNC_CONFLICT_PREFERENCES.defaultBehavior;

  const directionInput = input.directionPreferences;

  return {
    defaultBehavior,
    directionPreferences: {
      "noosphere-to-vault": isSyncConflictBehavior(directionInput?.["noosphere-to-vault"])
        ? directionInput["noosphere-to-vault"]
        : DEFAULT_SYNC_CONFLICT_PREFERENCES.directionPreferences["noosphere-to-vault"],
      "vault-to-noosphere": isSyncConflictBehavior(directionInput?.["vault-to-noosphere"])
        ? directionInput["vault-to-noosphere"]
        : DEFAULT_SYNC_CONFLICT_PREFERENCES.directionPreferences["vault-to-noosphere"],
    },
  };
}

export function mergeSyncConflictPreferences(
  base: SyncConflictPreferences,
  updates: SyncConflictPreferencesUpdate,
): SyncConflictPreferences {
  return normalizeSyncConflictPreferences({
    defaultBehavior: updates.defaultBehavior ?? base.defaultBehavior,
    directionPreferences: {
      ...base.directionPreferences,
      ...updates.directionPreferences,
    },
  });
}

export function validateSyncConflictPreferencesUpdate(
  body: unknown,
): SyncConflictPreferencesValidationResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: ["Body must be a JSON object"] };
  }

  const input = body as Record<string, unknown>;
  const errors: string[] = [];
  const updates: SyncConflictPreferencesUpdate = {};

  for (const key of Object.keys(input)) {
    if (!ALLOWED_TOP_LEVEL_FIELDS.has(key)) {
      errors.push(`${key} is not a supported setting`);
    }
  }

  if ("defaultBehavior" in input) {
    if (isSyncConflictBehavior(input["defaultBehavior"])) {
      updates.defaultBehavior = input["defaultBehavior"];
    } else {
      errors.push(`defaultBehavior must be one of: ${SYNC_CONFLICT_BEHAVIORS.join(", ")}`);
    }
  }

  if ("directionPreferences" in input) {
    const directionPreferences = input["directionPreferences"];
    if (
      typeof directionPreferences !== "object" ||
      directionPreferences === null ||
      Array.isArray(directionPreferences)
    ) {
      errors.push("directionPreferences must be an object");
    } else {
      const nextDirections: Partial<SyncConflictDirectionPreferences> = {};
      for (const [direction, behavior] of Object.entries(directionPreferences)) {
        if (!VALID_DIRECTIONS.has(direction)) {
          errors.push(`${direction} is not a supported sync direction`);
          continue;
        }
        if (!isSyncConflictBehavior(behavior)) {
          errors.push(`${direction} must be one of: ${SYNC_CONFLICT_BEHAVIORS.join(", ")}`);
          continue;
        }
        nextDirections[direction as SyncConflictDirection] = behavior;
      }
      updates.directionPreferences = nextDirections;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, updates };
}

export function validateSyncConflictPreferencesContentLength(
  contentLength: string | null,
  maxBytes = SYNC_CONFLICT_PREFERENCES_MAX_BODY_BYTES,
): ContentLengthValidationResult {
  if (contentLength === null) {
    return { ok: true };
  }

  const normalizedLength = contentLength.trim();
  if (!/^\d+$/.test(normalizedLength)) {
    return {
      ok: false,
      status: 400,
      error: "Invalid content-length header",
    };
  }

  const parsedLength = Number(normalizedLength);
  if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
    return {
      ok: false,
      status: 400,
      error: "Invalid content-length header",
    };
  }

  if (parsedLength > maxBytes) {
    return {
      ok: false,
      status: 413,
      error: `Request body too large. Maximum size is ${maxBytes} bytes.`,
    };
  }

  return { ok: true };
}

export function toPublicSyncConflictPreferences(
  preferences: SyncConflictPreferences,
  updatedAt: Date | string | null,
): PublicSyncConflictPreferences {
  return {
    ...preferences,
    directionPreferences: { ...preferences.directionPreferences },
    updatedAt: updatedAt instanceof Date ? updatedAt.toISOString() : updatedAt,
    allowedBehaviors: SYNC_CONFLICT_BEHAVIORS,
    allowedDirections: SYNC_CONFLICT_DIRECTIONS,
  };
}
