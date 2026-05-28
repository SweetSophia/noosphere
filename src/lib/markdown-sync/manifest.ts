import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import type { Manifest } from "@/lib/obsidian-sync";

/**
 * Load and validate a Markdown sync manifest from the configured vault.
 */
export function loadManifest(vaultPath: string, manifestRelPath: string): Manifest | null {
  const manifestAbsPath = resolve(vaultPath, manifestRelPath);
  if (!existsSync(manifestAbsPath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(manifestAbsPath, "utf-8")) as Manifest;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}
