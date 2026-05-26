import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SYNC_CONFLICT_PREFERENCES,
  SYNC_CONFLICT_PREFERENCES_READ_PERMISSIONS,
  SYNC_CONFLICT_PREFERENCES_WRITE_PERMISSIONS,
  mergeSyncConflictPreferences,
  normalizeSyncConflictPreferences,
  toPublicSyncConflictPreferences,
  validateSyncConflictPreferencesContentLength,
  validateSyncConflictPreferencesUpdate,
} from "@/lib/markdown-sync/conflict-preferences";

test("sync conflict preferences API policy allows READ gets and ADMIN writes", () => {
  assert.deepEqual(SYNC_CONFLICT_PREFERENCES_READ_PERMISSIONS, ["READ"]);
  assert.deepEqual(SYNC_CONFLICT_PREFERENCES_WRITE_PERMISSIONS, ["ADMIN"]);
});

test("sync conflict preferences default to manual review for both directions", () => {
  const preferences = normalizeSyncConflictPreferences();

  assert.equal(preferences.defaultBehavior, "manual-review");
  assert.equal(preferences.directionPreferences["noosphere-to-vault"], "manual-review");
  assert.equal(preferences.directionPreferences["vault-to-noosphere"], "manual-review");
});

test("sync conflict preferences accept all supported behaviors per direction", () => {
  const preferences = normalizeSyncConflictPreferences({
    defaultBehavior: "preserve",
    directionPreferences: {
      "noosphere-to-vault": "overwrite",
      "vault-to-noosphere": "manual-review",
    },
  });

  assert.equal(preferences.defaultBehavior, "preserve");
  assert.equal(preferences.directionPreferences["noosphere-to-vault"], "overwrite");
  assert.equal(preferences.directionPreferences["vault-to-noosphere"], "manual-review");
});

test("mergeSyncConflictPreferences applies partial direction updates", () => {
  const merged = mergeSyncConflictPreferences(DEFAULT_SYNC_CONFLICT_PREFERENCES, {
    directionPreferences: {
      "vault-to-noosphere": "preserve",
    },
  });

  assert.equal(merged.defaultBehavior, "manual-review");
  assert.equal(merged.directionPreferences["noosphere-to-vault"], "manual-review");
  assert.equal(merged.directionPreferences["vault-to-noosphere"], "preserve");
});

test("validateSyncConflictPreferencesUpdate rejects invalid behaviors and directions", () => {
  const result = validateSyncConflictPreferencesUpdate({
    defaultBehavior: "merge",
    directionPreferences: {
      "vault-to-noosphere": "preserve",
      "sideways": "overwrite",
      "noosphere-to-vault": "replace",
    },
    extra: true,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((error) => error.includes("defaultBehavior")));
  assert.ok(result.errors.some((error) => error.includes("sideways")));
  assert.ok(result.errors.some((error) => error.includes("noosphere-to-vault")));
  assert.ok(result.errors.some((error) => error.includes("extra")));
});

test("validateSyncConflictPreferencesUpdate returns normalized partial updates", () => {
  const result = validateSyncConflictPreferencesUpdate({
    defaultBehavior: "overwrite",
    directionPreferences: {
      "vault-to-noosphere": "manual-review",
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.updates.defaultBehavior, "overwrite");
  assert.deepEqual(result.updates.directionPreferences, {
    "vault-to-noosphere": "manual-review",
  });
});

test("validateSyncConflictPreferencesContentLength rejects malformed and oversized headers", () => {
  assert.deepEqual(validateSyncConflictPreferencesContentLength(null, 10), { ok: true });
  assert.deepEqual(validateSyncConflictPreferencesContentLength("10", 10), { ok: true });
  assert.deepEqual(validateSyncConflictPreferencesContentLength("abc", 10), {
    ok: false,
    status: 400,
    error: "Invalid content-length header",
  });
  assert.deepEqual(validateSyncConflictPreferencesContentLength("", 10), {
    ok: false,
    status: 400,
    error: "Invalid content-length header",
  });
  assert.deepEqual(validateSyncConflictPreferencesContentLength("-1", 10), {
    ok: false,
    status: 400,
    error: "Invalid content-length header",
  });
  assert.deepEqual(validateSyncConflictPreferencesContentLength("11", 10), {
    ok: false,
    status: 413,
    error: "Request body too large. Maximum size is 10 bytes.",
  });
});

test("toPublicSyncConflictPreferences exposes safe metadata only", () => {
  const updatedAt = new Date("2026-05-26T17:20:00Z");
  const publicPreferences = toPublicSyncConflictPreferences(DEFAULT_SYNC_CONFLICT_PREFERENCES, updatedAt);

  assert.equal(publicPreferences.updatedAt, "2026-05-26T17:20:00.000Z");
  assert.deepEqual(publicPreferences.allowedBehaviors, ["preserve", "overwrite", "manual-review"]);
  assert.deepEqual(publicPreferences.allowedDirections, ["noosphere-to-vault", "vault-to-noosphere"]);
  assert.equal("id" in publicPreferences, false);
});
