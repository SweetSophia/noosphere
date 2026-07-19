import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  HybridProviderError,
  canonicalEndpointIdentity,
  computeRetryDelayMs,
  endpointIdentitySha256,
  parseProviderConfigs,
  providerConfigJsonFromEnv,
  requestEmbedding,
  validateLeaseWindow,
  validateEmbeddingPayload,
  vectorSqlLiteral,
} from "./hybrid-provider.mjs";

const profileId = "11111111-1111-4111-8111-111111111111";
const testApiKey = randomBytes(24).toString("hex");
const job = {
  profile_id: profileId,
  provider_protocol: "openai-compatible",
  locality: "local",
  endpoint_identity_sha256: endpointIdentitySha256("http://127.0.0.1:8080/v1/embeddings", "local"),
  model_identifier: "fixture-model",
  model_revision: "fixture-r1",
  normalization_policy: "none",
  dimensions: 3,
  canonical_document: Buffer.from("fixture"),
};

test("endpoint identity excludes no mutable or credential-bearing URL components", () => {
  assert.equal(canonicalEndpointIdentity("https://EXAMPLE.com/v1/embeddings/", "remote"), "https://example.com/v1/embeddings");
  assert.equal(canonicalEndpointIdentity("http://host.docker.internal:11434/v1/embeddings", "local"), "http://host.docker.internal:11434/v1/embeddings");
  assert.equal(canonicalEndpointIdentity("https://localhost/v1/embeddings", "local"), "https://localhost/v1/embeddings");
  assert.equal(canonicalEndpointIdentity("http://[::1]:8080/v1/embeddings", "local"), "http://[::1]:8080/v1/embeddings");
  assert.throws(() => canonicalEndpointIdentity("https://example.com/v1/embeddings?key=secret", "remote"), /query parameters/);
  assert.throws(() => canonicalEndpointIdentity("http://example.com/v1/embeddings", "remote"), /HTTPS/);
  assert.throws(() => canonicalEndpointIdentity("http://192.168.1.10/v1/embeddings", "local"), /loopback/);
  assert.throws(() => canonicalEndpointIdentity("https://example.com/v1/embeddings", "local"), /Local hybrid providers/);
});

test("provider configs are unique, locality-bound, and require remote authentication", () => {
  const configs = parseProviderConfigs(JSON.stringify([{ profileId, locality: "local", endpoint: "http://localhost:8080/v1/embeddings" }]));
  assert.equal(configs.get(profileId).endpoint, "http://localhost:8080/v1/embeddings");
  assert.throws(() => parseProviderConfigs(JSON.stringify([{ profileId, locality: "remote", endpoint: "https://example.com/v1/embeddings" }])), /API key/);
  assert.throws(() => parseProviderConfigs(JSON.stringify([
    { profileId, locality: "local", endpoint: "http://localhost:8080/a" },
    { profileId, locality: "local", endpoint: "http://localhost:8080/b" },
  ])), /Duplicate/);
});

test("provider configuration base64 preserves Compose-sensitive credentials", () => {
  const raw = JSON.stringify([{
    profileId,
    locality: "remote",
    endpoint: "https://example.com/v1/embeddings",
    apiKey: "contains-$-and-#-without-interpolation",
  }]);
  const encoded = Buffer.from(raw, "utf8").toString("base64");
  assert.equal(providerConfigJsonFromEnv({ NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64: encoded }), raw);
  assert.throws(
    () => providerConfigJsonFromEnv({
      NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64: encoded,
      NOOSPHERE_HYBRID_PROVIDER_CONFIG_JSON: raw,
    }),
    /only one/,
  );
  assert.throws(
    () => providerConfigJsonFromEnv({ NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64: "not-base64" }),
    /canonical base64/,
  );
});

test("response validation rejects model, revision, dimension, and finite-value drift", () => {
  const valid = { model: "fixture-model", model_revision: "fixture-r1", data: [{ embedding: [1, 2, 3] }] };
  assert.deepEqual(validateEmbeddingPayload(valid, job), [1, 2, 3]);
  assert.throws(() => validateEmbeddingPayload({ ...valid, model: "other" }, job), /model/);
  assert.throws(() => validateEmbeddingPayload({ ...valid, model_revision: "other" }, job), /revision/);
  assert.throws(() => validateEmbeddingPayload({ ...valid, data: [{ embedding: [1, 2] }] }, job), /dimensions/);
  assert.throws(() => validateEmbeddingPayload({ ...valid, data: [{ embedding: [1, 2, Infinity] }] }, job), /components/);
});

test("L2 normalization and SQL vector serialization are deterministic", () => {
  const normalized = validateEmbeddingPayload(
    { model: "fixture-model", data: [{ embedding: [3, 4, 0] }] },
    { ...job, normalization_policy: "l2" },
  );
  assert.deepEqual(normalized, [0.6, 0.8, 0]);
  assert.equal(vectorSqlLiteral(normalized), "[0.6,0.8,0]");
});

test("provider request authenticates, bounds content, and returns one validated vector", async () => {
  let observed;
  const provider = {
    profileId,
    locality: "local",
    endpoint: "http://127.0.0.1:8080/v1/embeddings",
    endpointIdentitySha256: job.endpoint_identity_sha256,
    apiKey: testApiKey,
  };
  const embedding = await requestEmbedding(job, provider, {
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return new Response(JSON.stringify({ model: "fixture-model", data: [{ embedding: [1, 2, 3] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(embedding, [1, 2, 3]);
  assert.equal(observed.init.headers.authorization, `Bearer ${testApiKey}`);
  assert.equal(JSON.parse(observed.init.body).input, "fixture");

  await assert.rejects(
    requestEmbedding({ ...job, provider_protocol: "unsupported" }, provider, { fetchImpl: async () => assert.fail("transport must not run") }),
    (error) => error instanceof HybridProviderError && error.code === "provider_protocol_unsupported",
  );

  const aborted = new AbortController();
  aborted.abort(new Error("worker shutdown"));
  await assert.rejects(
    requestEmbedding(job, provider, {
      signal: aborted.signal,
      fetchImpl: async () => assert.fail("transport must not run for an already-aborted request"),
    }),
    (error) => error instanceof HybridProviderError && error.code === "provider_timeout",
  );

  await assert.rejects(
    requestEmbedding(job, provider, {
      maxResponseBytes: 10,
      fetchImpl: async () => new Response(JSON.stringify({ model: "fixture-model", data: [{ embedding: [1, 2, 3] }] }), {
        headers: { "content-type": "application/json" },
      }),
    }),
    (error) => error instanceof HybridProviderError && error.code === "provider_response_too_large",
  );
});

test("retry delay is bounded exponential backoff with jitter", () => {
  assert.equal(computeRetryDelayMs(1, () => 0), 750);
  assert.equal(computeRetryDelayMs(2, () => 0.5), 2_000);
  assert.equal(computeRetryDelayMs(20, () => 1), 375_000);
});

test("worker lease must outlive the provider timeout with a safety margin", () => {
  assert.doesNotThrow(() => validateLeaseWindow(35, 30_000));
  assert.throws(() => validateLeaseWindow(30, 30_000), /outlive/);
  assert.throws(() => validateLeaseWindow(30, 120_000), /outlive/);
});
