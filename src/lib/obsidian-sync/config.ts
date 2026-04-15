/**
 * Obsidian Shadow Sync — Configuration
 *
 * Parses and validates environment variables for the obsidian sync feature.
 * All paths are validated to be absolute and writable.
 */

export interface ObsidianSyncConfig {
  enabled: boolean;
  vaultPath: string;
  gitEnabled: boolean;
  autoClean: boolean;
  preserveLocalChanges: boolean;
  trashDeletions: boolean;
  manifestPath: string; // relative inside vault
  lastRunPath: string; // relative inside vault
  timeoutMs: number;
}

function parseBool(env: string | undefined, fallback: boolean): boolean {
  if (env === undefined) return fallback;
  return env === "true" || env === "1";
}

function parseEnvInt(env: string | undefined, fallback: number): number {
  if (env === undefined) return fallback;
  const n = parseInt(env, 10);
  return isNaN(n) ? fallback : n;
}

export function getObsidianSyncConfig(): ObsidianSyncConfig | null {
  const enabled = parseBool(process.env["OBSIDIAN_SYNC_ENABLED"], false);

  if (!enabled) {
    return null;
  }

  const vaultPath = process.env["OBSIDIAN_VAULT_PATH"];
  if (!vaultPath) {
    throw new Error("OBSIDIAN_SYNC_ENABLED is true but OBSIDIAN_VAULT_PATH is not set");
  }

  // Ensure absolute path
  if (!vaultPath.startsWith("/")) {
    throw new Error(`OBSIDIAN_VAULT_PATH must be an absolute path, got: ${vaultPath}`);
  }

  return {
    enabled: true,
    vaultPath,
    gitEnabled: parseBool(process.env["OBSIDIAN_SYNC_GIT_ENABLED"], false),
    autoClean: parseBool(process.env["OBSIDIAN_SYNC_AUTO_CLEAN"], true),
    preserveLocalChanges: parseBool(process.env["OBSIDIAN_SYNC_PRESERVE_LOCAL_CHANGES"], true),
    trashDeletions: parseBool(process.env["OBSIDIAN_SYNC_TRASH_DELETIONS"], true),
    manifestPath: process.env["OBSIDIAN_SYNC_MANIFEST_PATH"] ?? ".noosphere-sync/manifest.json",
    lastRunPath: process.env["OBSIDIAN_SYNC_LAST_RUN_PATH"] ?? ".noosphere-sync/last-run.json",
    timeoutMs: parseEnvInt(process.env["OBSIDIAN_SYNC_TIMEOUT_MS"], 60_000),
  };
}
