import {
  normalizeMemoryProviderConfig,
  type MemoryProvider,
  type MemoryProviderGetOptions,
} from "@/lib/memory/provider";
import type { MemoryResult } from "@/lib/memory/types";

export const MEMORY_GET_LIMITS = {
  maxIdLength: 512,
  maxProviderLength: 64,
  timeoutMs: 5000,
} as const;

const PROVIDER_ID_PATTERN = /^[a-z0-9-]+$/;
const CANONICAL_REF_TYPES_BY_PROVIDER: Record<string, Set<string>> = {
  noosphere: new Set(["article"]),
};

export interface MemoryGetRequest {
  provider?: string;
  id?: string;
  canonicalRef?: string;
}

export interface MemoryGetResponse {
  result: MemoryResult | null;
  providerMeta: MemoryGetProviderMeta[];
}

export interface MemoryGetProviderMeta {
  providerId: string;
  enabled: boolean;
  found: boolean;
  error?: string;
  durationMs?: number;
}

export interface MemoryGetExecutionOptions {
  providers?: MemoryProvider[];
  providerOptions?: MemoryProviderGetOptions;
  timeoutMs?: number;
}

export type MemoryGetValidationResult =
  | {
      ok: true;
      request: {
        provider: string;
        id: string;
        canonicalRef?: string;
      };
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

export async function getDefaultMemoryGetProviders(): Promise<
  MemoryProvider[]
> {
  const { createNoosphereProvider } = await import("@/lib/memory/noosphere");
  return [createNoosphereProvider()];
}

export function validateMemoryGetRequest(
  input: unknown,
): MemoryGetValidationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, status: 400, error: "Request body must be an object" };
  }

  const body = input as Record<string, unknown>;
  const providerField = readOptionalRequestField(body, "provider");
  if (!providerField.ok) return providerField;
  const idField = readOptionalRequestField(body, "id");
  if (!idField.ok) return idField;
  const canonicalRefField = readOptionalRequestField(body, "canonicalRef");
  if (!canonicalRefField.ok) return canonicalRefField;

  const explicitProvider = providerField.value;
  const explicitId = idField.value;
  const canonicalRef = canonicalRefField.value;

  if (canonicalRef && (explicitProvider || explicitId)) {
    return {
      status: 400,
      ok: false,
      error: "Use either canonicalRef or provider + id, not both",
    };
  }

  if (canonicalRef) {
    return parseCanonicalRef(canonicalRef);
  }

  if (!explicitProvider) {
    return { ok: false, status: 400, error: "provider is required" };
  }
  if (!explicitId) {
    return { ok: false, status: 400, error: "id is required" };
  }

  const providerValidationError = validateProviderId(explicitProvider);
  if (providerValidationError) return providerValidationError;

  if (explicitId.length > MEMORY_GET_LIMITS.maxIdLength) {
    return { ok: false, status: 400, error: "id is too long" };
  }

  return { ok: true, request: { provider: explicitProvider, id: explicitId } };
}

export async function executeMemoryGetRequest(
  input: unknown,
  options: MemoryGetExecutionOptions = {},
): Promise<{ status: number; body: MemoryGetResponse | { error: string } }> {
  const validation = validateMemoryGetRequest(input);
  if (!validation.ok) {
    return { status: validation.status, body: { error: validation.error } };
  }

  const providers = options.providers ?? (await getDefaultMemoryGetProviders());
  const provider = providers.find(
    (entry) => entry.descriptor.id === validation.request.provider,
  );
  if (!provider) {
    return {
      status: 400,
      body: { error: `Unknown provider ID: ${validation.request.provider}` },
    };
  }

  const startedAt = Date.now();
  const config = normalizeMemoryProviderConfig({
    ...provider.descriptor.defaultConfig,
    ...options.providerOptions?.config,
  });

  if (!config.enabled) {
    return {
      status: 200,
      body: {
        result: null,
        providerMeta: [
          {
            providerId: provider.descriptor.id,
            enabled: false,
            found: false,
            durationMs: Date.now() - startedAt,
          },
        ],
      },
    };
  }

  if (!provider.descriptor.capabilities.getById) {
    return {
      status: 200,
      body: {
        result: null,
        providerMeta: [
          {
            providerId: provider.descriptor.id,
            enabled: true,
            found: false,
            error: "Provider does not support getById",
            durationMs: Date.now() - startedAt,
          },
        ],
      },
    };
  }

  const controller = new AbortController();
  const timeoutMs = clampPositiveInteger(
    options.timeoutMs,
    MEMORY_GET_LIMITS.timeoutMs,
    Number.MAX_SAFE_INTEGER,
  );

  try {
    const result = await withTimeout(
      provider.getById(validation.request.id, {
        ...options.providerOptions,
        signal: controller.signal,
      }),
      timeoutMs,
      () => {
        controller.abort();
        return Promise.reject(
          new Error(`Provider lookup timed out after ${timeoutMs}ms`),
        );
      },
    );
    return {
      status: 200,
      body: {
        result,
        providerMeta: [
          {
            providerId: provider.descriptor.id,
            enabled: true,
            found: result !== null,
            durationMs: Date.now() - startedAt,
          },
        ],
      },
    };
  } catch (error) {
    return {
      status: 200,
      body: {
        result: null,
        providerMeta: [
          {
            providerId: provider.descriptor.id,
            enabled: true,
            found: false,
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - startedAt,
          },
        ],
      },
    };
  } finally {
    controller.abort();
  }
}

function parseCanonicalRef(canonicalRef: string): MemoryGetValidationResult {
  if (canonicalRef.length > MEMORY_GET_LIMITS.maxIdLength) {
    return { ok: false, status: 400, error: "canonicalRef is too long" };
  }

  const segments = canonicalRef.split(":").map((segment) => segment.trim());
  if (segments.length < 3 || segments.some((segment) => !segment)) {
    return {
      ok: false,
      status: 400,
      error: "canonicalRef must look like provider:type:id",
    };
  }

  const [provider, type] = segments;
  const providerValidationError = validateProviderId(provider);
  if (providerValidationError) return providerValidationError;

  const allowedTypes = CANONICAL_REF_TYPES_BY_PROVIDER[provider];
  if (allowedTypes && !allowedTypes.has(type)) {
    return {
      ok: false,
      status: 400,
      error: `Unsupported canonicalRef type for ${provider}: ${type}`,
    };
  }

  return {
    ok: true,
    request: {
      provider,
      id: segments.slice(2).join(":"),
      canonicalRef: segments.join(":"),
    },
  };
}

function readOptionalRequestField(
  body: Record<string, unknown>,
  field: keyof MemoryGetRequest,
):
  | { ok: true; value: string | undefined }
  | Extract<MemoryGetValidationResult, { ok: false }> {
  if (!(field in body) || body[field] === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof body[field] !== "string") {
    return { ok: false, status: 400, error: `${field} must be a string` };
  }
  const value = body[field].trim();
  if (!value) {
    return { ok: true, value: undefined };
  }
  return { ok: true, value };
}

function validateProviderId(
  provider: string,
): Extract<MemoryGetValidationResult, { ok: false }> | undefined {
  if (provider.length > MEMORY_GET_LIMITS.maxProviderLength) {
    return { ok: false, status: 400, error: "provider is too long" };
  }
  if (!PROVIDER_ID_PATTERN.test(provider)) {
    return {
      ok: false,
      status: 400,
      error:
        "provider must contain only lowercase letters, numbers, and hyphens",
    };
  }
  return undefined;
}

function clampPositiveInteger(
  value: unknown,
  fallback: number,
  max: number,
): number {
  const parsed = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T | Promise<T>,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve, reject) => {
        timeout = setTimeout(() => {
          Promise.resolve(onTimeout()).then(resolve, reject);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
