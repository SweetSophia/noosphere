export interface ResolvedNoosphereConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
}

export class NoosphereConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoosphereConfigError";
  }
}

export const DEFAULT_NOOSPHERE_BASE_URL = "http://127.0.0.1:6578";
export const DEFAULT_NOOSPHERE_TIMEOUT_MS = 5_000;
export const MIN_NOOSPHERE_TIMEOUT_MS = 500;
export const MAX_NOOSPHERE_TIMEOUT_MS = 30_000;

type Environment = Record<string, string | undefined>;

export function resolveNoosphereConfig(
  env: Environment = process.env,
): ResolvedNoosphereConfig {
  const baseUrl = normalizeBaseUrl(
    readString(env.CODEX_NOOSPHERE_BASE_URL) ??
      readString(env.NOOSPHERE_BASE_URL) ??
      DEFAULT_NOOSPHERE_BASE_URL,
  );
  assertTrustedDestination(baseUrl, env);

  return {
    baseUrl,
    apiKey:
      readString(env.CODEX_NOOSPHERE_API_KEY) ??
      readString(env.NOOSPHERE_API_KEY),
    timeoutMs: resolveTimeout(
      readString(env.CODEX_NOOSPHERE_TIMEOUT_MS) ??
        readString(env.NOOSPHERE_TIMEOUT_MS),
    ),
  };
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new NoosphereConfigError(
      "Noosphere base URL must be a valid HTTP or HTTPS URL.",
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new NoosphereConfigError(
      "Noosphere base URL must be a valid HTTP or HTTPS URL.",
    );
  }
  if (url.username || url.password) {
    throw new NoosphereConfigError(
      "Noosphere base URL must not contain credentials.",
    );
  }
  if (trimmed.includes("?") || trimmed.includes("#")) {
    throw new NoosphereConfigError(
      "Noosphere base URL must not contain a query string or fragment.",
    );
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new NoosphereConfigError(
      "Noosphere base URL must use HTTPS unless the host is loopback.",
    );
  }

  while (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  const normalized = url.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function assertTrustedDestination(baseUrl: string, env: Environment): void {
  const base = new URL(baseUrl);
  if (isLoopbackHost(base.hostname)) return;

  const rawTrustedOrigin =
    readString(env.CODEX_NOOSPHERE_TRUSTED_ORIGIN) ??
    readString(env.NOOSPHERE_TRUSTED_ORIGIN);
  if (!rawTrustedOrigin) {
    throw new NoosphereConfigError(
      "Remote Noosphere base URL requires CODEX_NOOSPHERE_TRUSTED_ORIGIN (or NOOSPHERE_TRUSTED_ORIGIN) in the process environment.",
    );
  }

  const trustedOrigin = normalizeTrustedOrigin(rawTrustedOrigin);
  if (base.origin !== trustedOrigin) {
    throw new NoosphereConfigError(
      "Noosphere base URL origin does not match the configured trusted origin.",
    );
  }
}

function normalizeTrustedOrigin(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw invalidTrustedOriginError();
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    trimmed.includes("?") ||
    trimmed.includes("#")
  ) {
    throw invalidTrustedOriginError();
  }
  return url.origin;
}

function invalidTrustedOriginError(): NoosphereConfigError {
  return new NoosphereConfigError(
    "Noosphere trusted origin must be an HTTPS origin without credentials, path, query, or fragment.",
  );
}

function isLoopbackHost(hostname: string): boolean {
  const withoutBrackets = stripIpv6Brackets(hostname.toLowerCase());
  const normalized = withoutBrackets.endsWith(".")
    ? withoutBrackets.slice(0, -1)
    : withoutBrackets;
  const ipv4 = parseIpv4(normalized) ?? parseIpv4MappedIpv6(normalized);
  return normalized === "localhost" || normalized === "::1" || ipv4?.[0] === 127;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function parseIpv4(hostname: string): [number, number, number, number] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    const parsed = Number(part);
    return parsed >= 0 && parsed <= 255 ? parsed : Number.NaN;
  });
  return octets.every((part) => Number.isInteger(part))
    ? (octets as [number, number, number, number])
    : undefined;
}

function parseIpv4MappedIpv6(
  hostname: string,
): [number, number, number, number] | undefined {
  const match = /^::ffff:(.+)$/i.exec(hostname);
  if (!match) return undefined;

  const dotted = parseIpv4(match[1]);
  if (dotted) return dotted;

  const words = match[1].split(":");
  if (words.length !== 2 || words.some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) {
    return undefined;
  }
  const high = Number.parseInt(words[0], 16);
  const low = Number.parseInt(words[1], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function resolveTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_NOOSPHERE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_NOOSPHERE_TIMEOUT_MS;
  return Math.min(
    MAX_NOOSPHERE_TIMEOUT_MS,
    Math.max(MIN_NOOSPHERE_TIMEOUT_MS, Math.round(parsed)),
  );
}

function readString(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
