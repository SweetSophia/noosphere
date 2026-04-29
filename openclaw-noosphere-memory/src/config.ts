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
  const apiKey = readSecret(config.apiKey) || env.NOOSPHERE_API_KEY;
  const timeoutMs = clampTimeout(config.timeoutMs ?? readNumber(env.NOOSPHERE_TIMEOUT_MS), DEFAULT_NOOSPHERE_TIMEOUT_MS);

  return { baseUrl, apiKey, timeoutMs };
}

export function redactSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= 8) return "[redacted]";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function readSecret(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (isRecord(value) && typeof value.value === "string" && value.value.trim()) {
    return value.value.trim();
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
