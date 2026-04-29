export interface NoosphereMemoryConfig {
  baseUrl?: string;
  apiKey?: string | { value?: string };
  timeoutMs?: number;
}

export interface ResolvedNoosphereMemoryConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
}

export const DEFAULT_NOOSPHERE_BASE_URL = "http://localhost:3000";
export const DEFAULT_NOOSPHERE_TIMEOUT_MS = 5_000;
export const MAX_NOOSPHERE_TIMEOUT_MS = 30_000;

export function resolveNoosphereMemoryConfig(
  rawConfig: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedNoosphereMemoryConfig {
  const config = isRecord(rawConfig) ? rawConfig as Partial<NoosphereMemoryConfig> : {};
  const baseUrl = normalizeBaseUrl(readString(config.baseUrl) || env.NOOSPHERE_BASE_URL || DEFAULT_NOOSPHERE_BASE_URL);
  const apiKey = readSecret(config.apiKey) || readString(env.NOOSPHERE_API_KEY);
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

function readSecret(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (isRecord(value) && typeof value.value === "string" && value.value.trim()) {
    return value.value.trim();
  }
  return undefined;
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

function clampTimeout(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(value), MAX_NOOSPHERE_TIMEOUT_MS);
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
