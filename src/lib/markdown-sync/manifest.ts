import type { Manifest } from "@/lib/obsidian-sync";
import { runtimeExists, runtimeReadFile, runtimeResolve } from "@/lib/runtime-fs";

/**
 * Load and validate a Markdown sync manifest from the configured vault.
 */
export function loadManifest(vaultPath: string, manifestRelPath: string): Manifest | null {
  const manifestAbsPath = runtimeResolve(vaultPath, manifestRelPath);
  if (!runtimeExists(manifestAbsPath)) return null;

  try {
    const parsed = JSON.parse(runtimeReadFile(manifestAbsPath, "utf-8")) as Manifest;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}
