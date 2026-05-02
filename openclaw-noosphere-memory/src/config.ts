import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export interface NoosphereMemoryConfig {
  baseUrl?: string;
  apiKey?: string | { value?: string } | SecretRefInput;
  timeoutMs?: number;
}

interface SecretRefInput {
  source?: unknown;
  provider?: unknown;
  id?: unknown;
}

export interface ResolvedNoosphereMemoryConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
}

export const DEFAULT_NOOSPHERE_BASE_URL = "http://localhost:3000";
export const DEFAULT_NOOSPHERE_TIMEOUT_MS = 5_000;
export const MAX_NOOSPHERE_TIMEOUT_MS = 30_000;
export const DEFAULT_AUTO_RECALL_TIMEOUT_MS = 1_500;
export const MAX_AUTO_RECALL_TIMEOUT_MS = 5_000;

export function resolveNoosphereMemoryConfig(
  rawConfig: unknown,
  env: NodeJS.ProcessEnv = process.env,
  rootConfig?: unknown,
): ResolvedNoosphereMemoryConfig {
  const config = isRecord(rawConfig) ? rawConfig as Partial<NoosphereMemoryConfig> : {};
  const baseUrl = normalizeBaseUrl(readString(config.baseUrl) || env.NOOSPHERE_BASE_URL || DEFAULT_NOOSPHERE_BASE_URL);
  const apiKey = readSecret(config.apiKey, rootConfig) || readString(env.NOOSPHERE_API_KEY);
  const timeoutMs = clampTimeout(config.timeoutMs ?? readNumber(env.NOOSPHERE_TIMEOUT_MS), DEFAULT_NOOSPHERE_TIMEOUT_MS);

  return { baseUrl, apiKey, timeoutMs };
}

export function redactSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= 8) return "[redacted]";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "") || DEFAULT_NOOSPHERE_BASE_URL;
}

function readSecret(value: unknown, rootConfig?: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!isRecord(value)) return undefined;
  if (typeof value.value === "string" && value.value.trim()) {
    return value.value.trim();
  }
  return readFileSecretRef(value, rootConfig);
}

function readFileSecretRef(value: Record<string, unknown>, rootConfig?: unknown): string | undefined {
  if (value.source !== "file") return undefined;
  const providerId = readString(value.provider);
  const secretId = readString(value.id);
  if (!providerId || !secretId || !isRecord(rootConfig)) return undefined;

  const providers = getRecord(rootConfig, "secrets", "providers");
  const provider = providers ? providers[providerId] : undefined;
  if (!isRecord(provider) || provider.source !== "file") return undefined;

  const rawPath = readString(provider.path);
  if (!rawPath) return undefined;
  const filePath = expandHome(rawPath);
  const fileContent = readFileSync(filePath, "utf8");

  if (provider.mode === "json") {
    const parsed = JSON.parse(fileContent) as unknown;
    const resolved = readJsonPointer(parsed, secretId);
    return typeof resolved === "string" && resolved.trim() ? resolved.trim() : undefined;
  }

  const trimmed = fileContent.trim();
  return trimmed || undefined;
}

function getRecord(value: unknown, ...path: string[]): Record<string, unknown> | undefined {
  let current: unknown = value;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return isRecord(current) ? current : undefined;
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return `${homedir()}${input.slice(1)}`;
  return input;
}

function readJsonPointer(value: unknown, pointer: string): unknown {
  if (!pointer || pointer === "/") return value;
  const parts = pointer.split("/").slice(1).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current = value;
  for (const part of parts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function clampTimeout(value: unknown, fallback: number, max: number = MAX_NOOSPHERE_TIMEOUT_MS): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(value), max);
}

export function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return undefined;
}

export function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter((item): item is string => typeof item === "string" && !!item.trim())
    .map((item) => item.trim());
  return values.length > 0 ? values : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
