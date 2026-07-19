import { createHash } from "node:crypto";

export const HYBRID_LIMITS = Object.freeze({
  concurrency: { default: 4, min: 1, max: 16 },
  leaseSeconds: { default: 120, min: 30, max: 900 },
  maxAttempts: { default: 8, min: 1, max: 20 },
  pollMs: { default: 1_000, min: 100, max: 60_000 },
  requestTimeoutMs: { default: 30_000, min: 1_000, max: 120_000 },
  responseBytes: { default: 4_194_304, min: 1_024, max: 16_777_216 },
  queueWarningDepth: { default: 1_000, min: 1, max: 1_000_000 },
  queueCriticalDepth: { default: 10_000, min: 2, max: 10_000_000 },
  queueWarningAgeSeconds: { default: 300, min: 1, max: 86_400 },
  queueCriticalAgeSeconds: { default: 1_800, min: 2, max: 604_800 },
  backfillChunk: { default: 100, min: 1, max: 1_000 },
});

export const HYBRID_LEASE_SAFETY_MARGIN_MS = 5_000;

export class HybridProviderError extends Error {
  constructor(code, message, { retryable = false, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HybridProviderError";
    this.code = sanitizeErrorCode(code);
    this.retryable = retryable;
  }
}

export function readBoundedInteger(value, name, limits) {
  const raw = value === undefined || value === "" ? limits.default : Number(value);
  if (!Number.isSafeInteger(raw) || raw < limits.min || raw > limits.max) {
    throw new Error(`${name} must be an integer between ${limits.min} and ${limits.max}`);
  }
  return raw;
}

export function validateLeaseWindow(leaseSeconds, requestTimeoutMs) {
  if (leaseSeconds * 1_000 < requestTimeoutMs + HYBRID_LEASE_SAFETY_MARGIN_MS) {
    throw new Error(
      `NOOSPHERE_HYBRID_LEASE_SECONDS must outlive NOOSPHERE_HYBRID_REQUEST_TIMEOUT_MS by at least ${HYBRID_LEASE_SAFETY_MARGIN_MS}ms`,
    );
  }
}

export function canonicalEndpointIdentity(endpoint, locality) {
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Hybrid provider endpoint is not a valid absolute URL");
  }
  if (!['local', 'remote'].includes(locality)) {
    throw new Error("Hybrid provider locality must be local or remote");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Hybrid provider endpoints must not contain credentials, query parameters, or fragments");
  }
  if (locality === "remote" && parsed.protocol !== "https:") {
    throw new Error("Remote hybrid providers require HTTPS");
  }
  if (locality === "local") {
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
    if (!["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host)) {
      throw new Error("Local hybrid providers require loopback or the pinned container host gateway");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Local hybrid provider endpoints require HTTP or HTTPS");
    }
  }
  const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}`;
}

export function endpointIdentitySha256(endpoint, locality) {
  return createHash("sha256")
    .update(canonicalEndpointIdentity(endpoint, locality), "utf8")
    .digest("hex");
}

export function parseProviderConfigs(raw) {
  if (!raw) return new Map();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("NOOSPHERE_HYBRID_PROVIDER_CONFIG_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length > 100) {
    throw new Error("Hybrid provider configuration must be an array of at most 100 entries");
  }
  const result = new Map();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Each hybrid provider configuration must be an object");
    }
    const profileId = requireUuid(entry.profileId, "profileId");
    if (result.has(profileId)) {
      throw new Error(`Duplicate hybrid provider profileId: ${profileId}`);
    }
    const locality = entry.locality;
    const endpoint = canonicalEndpointIdentity(entry.endpoint, locality);
    const apiKey = entry.apiKey ?? "";
    if (typeof apiKey !== "string" || apiKey.length > 8_192 || /[\r\n]/u.test(apiKey)) {
      throw new Error(`Hybrid provider credential is invalid for profile ${profileId}`);
    }
    if (locality === "remote" && apiKey.length === 0) {
      throw new Error(`Remote hybrid provider requires an API key for profile ${profileId}`);
    }
    result.set(profileId, Object.freeze({
      profileId,
      locality,
      endpoint,
      endpointIdentitySha256: endpointIdentitySha256(endpoint, locality),
      apiKey,
    }));
  }
  return result;
}

export function providerConfigJsonFromEnv(env) {
  const encoded = env.NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64;
  const raw = env.NOOSPHERE_HYBRID_PROVIDER_CONFIG_JSON;
  if (encoded && raw) {
    throw new Error("Set only one hybrid provider configuration environment variable");
  }
  if (!encoded) return raw || "[]";
  if (
    encoded.length > 174_764 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)
  ) {
    throw new Error("NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64 must be canonical base64");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) {
    throw new Error("NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64 must be canonical base64");
  }
  const json = decoded.toString("utf8");
  if (!Buffer.from(json, "utf8").equals(decoded)) {
    throw new Error("Hybrid provider configuration must be valid UTF-8");
  }
  return json;
}

export async function requestEmbedding(job, provider, options = {}) {
  if (job.provider_protocol !== "openai-compatible") {
    throw new HybridProviderError("provider_protocol_unsupported", "Embedding profile uses an unsupported provider protocol");
  }
  if (provider.profileId !== job.profile_id || provider.locality !== job.locality) {
    throw new HybridProviderError("provider_config_mismatch", "Provider configuration does not match the claimed profile");
  }
  if (provider.endpointIdentitySha256 !== job.endpoint_identity_sha256) {
    throw new HybridProviderError("endpoint_identity_mismatch", "Provider endpoint identity does not match the immutable profile");
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? HYBRID_LIMITS.requestTimeoutMs.default;
  const maxResponseBytes = options.maxResponseBytes ?? HYBRID_LIMITS.responseBytes.default;
  const outerSignal = options.signal;
  const controller = new AbortController();
  const abortFromOuter = () => controller.abort(outerSignal?.reason);
  outerSignal?.addEventListener("abort", abortFromOuter, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("provider timeout")), timeoutMs);
  try {
    const headers = { "content-type": "application/json", accept: "application/json" };
    if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
    const response = await fetchImpl(provider.endpoint, {
      method: "POST",
      headers,
      redirect: "error",
      signal: controller.signal,
      body: JSON.stringify({
        model: job.model_identifier,
        input: Buffer.from(job.canonical_document).toString("utf8"),
        encoding_format: "float",
      }),
    });
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw new HybridProviderError(`provider_http_${response.status}`, "Embedding provider returned a non-success status", { retryable });
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      throw new HybridProviderError("provider_content_type", "Embedding provider did not return JSON");
    }
    const body = await readBoundedBody(response, maxResponseBytes);
    let payload;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      throw new HybridProviderError("provider_invalid_json", "Embedding provider returned invalid JSON");
    }
    return validateEmbeddingPayload(payload, job);
  } catch (error) {
    if (error instanceof HybridProviderError) throw error;
    if (controller.signal.aborted) {
      throw new HybridProviderError("provider_timeout", "Embedding provider request timed out or was cancelled", { retryable: true, cause: error });
    }
    throw new HybridProviderError("provider_network", "Embedding provider request failed", { retryable: true, cause: error });
  } finally {
    clearTimeout(timeout);
    outerSignal?.removeEventListener("abort", abortFromOuter);
  }
}

export function validateEmbeddingPayload(payload, job) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HybridProviderError("provider_response_shape", "Embedding response must be an object");
  }
  if (payload.model !== job.model_identifier) {
    throw new HybridProviderError("provider_model_mismatch", "Embedding response model does not match the immutable profile");
  }
  if (payload.model_revision !== undefined && payload.model_revision !== job.model_revision) {
    throw new HybridProviderError("provider_revision_mismatch", "Embedding response revision does not match the immutable profile");
  }
  if (!Array.isArray(payload.data) || payload.data.length !== 1 || !Array.isArray(payload.data[0]?.embedding)) {
    throw new HybridProviderError("provider_response_shape", "Embedding response must contain exactly one vector");
  }
  const embedding = payload.data[0].embedding;
  if (embedding.length !== job.dimensions || embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new HybridProviderError("provider_vector_invalid", "Embedding vector has invalid dimensions or components");
  }
  if (job.normalization_policy === "l2") {
    const norm = Math.hypot(...embedding);
    if (!Number.isFinite(norm) || norm === 0) {
      throw new HybridProviderError("provider_vector_invalid", "Embedding vector cannot be L2-normalized");
    }
    return embedding.map((component) => component / norm);
  }
  if (job.normalization_policy !== "none") {
    throw new HybridProviderError("profile_normalization_invalid", "Embedding profile normalization policy is unsupported");
  }
  return embedding;
}

export function vectorSqlLiteral(embedding) {
  if (!Array.isArray(embedding) || embedding.length === 0 || embedding.some((value) => !Number.isFinite(value))) {
    throw new Error("Cannot serialize an invalid embedding vector");
  }
  return `[${embedding.map((value) => Number(value).toString()).join(",")}]`;
}

export function computeRetryDelayMs(attemptCount, random = Math.random) {
  const exponent = Math.max(0, Math.min(10, attemptCount - 1));
  const base = Math.min(300_000, 1_000 * 2 ** exponent);
  return Math.round(base * (0.75 + random() * 0.5));
}

export function sanitizeErrorCode(code) {
  const normalized = String(code || "unknown").toLowerCase().replace(/[^a-z0-9_]/gu, "_").slice(0, 64);
  return normalized || "unknown";
}

async function readBoundedBody(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HybridProviderError("provider_response_too_large", "Embedding response exceeded the configured byte limit");
  }
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new HybridProviderError("provider_response_too_large", "Embedding response exceeded the configured byte limit");
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HybridProviderError("provider_response_too_large", "Embedding response exceeded the configured byte limit");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function requireUuid(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error(`Hybrid provider ${label} must be a UUID`);
  }
  return value.toLowerCase();
}
