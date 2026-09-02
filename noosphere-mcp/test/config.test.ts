import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_NOOSPHERE_BASE_URL,
  NoosphereConfigError,
  resolveNoosphereConfig,
} from "../src/config.js";

test("uses loopback defaults without requiring a credential at startup", () => {
  assert.deepEqual(resolveNoosphereConfig({}), {
    baseUrl: DEFAULT_NOOSPHERE_BASE_URL,
    apiKey: undefined,
    timeoutMs: 5_000,
  });
});

test("prefers Codex-specific environment variables over generic fallbacks", () => {
  const config = resolveNoosphereConfig({
    CODEX_NOOSPHERE_BASE_URL: "http://127.42.0.9:6578/",
    CODEX_NOOSPHERE_API_KEY: "codex-test-key",
    CODEX_NOOSPHERE_TIMEOUT_MS: "1200",
    NOOSPHERE_BASE_URL: "http://127.0.0.1:9999",
    NOOSPHERE_API_KEY: "generic-test-key",
    NOOSPHERE_TIMEOUT_MS: "9000",
  });

  assert.deepEqual(config, {
    baseUrl: "http://127.42.0.9:6578",
    apiKey: "codex-test-key",
    timeoutMs: 1_200,
  });
});

test("accepts IPv6 and IPv4-mapped loopback without a trust pin", () => {
  assert.equal(
    resolveNoosphereConfig({ CODEX_NOOSPHERE_BASE_URL: "http://[::1]:6578" }).baseUrl,
    "http://[::1]:6578",
  );
  assert.equal(
    resolveNoosphereConfig({
      CODEX_NOOSPHERE_BASE_URL: "http://[::ffff:127.0.0.42]:6578",
    }).baseUrl,
    "http://[::ffff:7f00:2a]:6578",
  );
});

test("rejects non-loopback HTTP before any credential can be used", () => {
  assert.throws(
    () =>
      resolveNoosphereConfig({
        CODEX_NOOSPHERE_BASE_URL: "http://noosphere.example.test",
        CODEX_NOOSPHERE_API_KEY: "synthetic-key",
        CODEX_NOOSPHERE_TRUSTED_ORIGIN: "https://noosphere.example.test",
      }),
    (error: unknown) =>
      error instanceof NoosphereConfigError &&
      /HTTPS unless the host is loopback/.test(error.message),
  );
});

test("requires an exact environment-bound origin for remote HTTPS", () => {
  assert.throws(
    () =>
      resolveNoosphereConfig({
        CODEX_NOOSPHERE_BASE_URL: "https://noosphere.example.test/api-root",
        CODEX_NOOSPHERE_API_KEY: "synthetic-key",
      }),
    /requires CODEX_NOOSPHERE_TRUSTED_ORIGIN/,
  );

  assert.throws(
    () =>
      resolveNoosphereConfig({
        CODEX_NOOSPHERE_BASE_URL: "https://noosphere.example.test:8443/api-root",
        CODEX_NOOSPHERE_TRUSTED_ORIGIN: "https://noosphere.example.test",
      }),
    /does not match/,
  );

  assert.equal(
    resolveNoosphereConfig({
      CODEX_NOOSPHERE_BASE_URL: "https://10.20.30.40:8443/noosphere/",
      CODEX_NOOSPHERE_TRUSTED_ORIGIN: "https://10.20.30.40:8443",
    }).baseUrl,
    "https://10.20.30.40:8443/noosphere",
  );
});

test("rejects ambiguous or credential-bearing URL forms", () => {
  for (const value of [
    "ftp://127.0.0.1:6578",
    "http://user:pass@127.0.0.1:6578",
    "http://127.0.0.1:6578?target=elsewhere",
    "http://127.0.0.1:6578/#fragment",
  ]) {
    assert.throws(
      () => resolveNoosphereConfig({ CODEX_NOOSPHERE_BASE_URL: value }),
      NoosphereConfigError,
      value,
    );
  }
});

test("normalizes timeout bounds and invalid values", () => {
  assert.equal(
    resolveNoosphereConfig({ CODEX_NOOSPHERE_TIMEOUT_MS: "1" }).timeoutMs,
    500,
  );
  assert.equal(
    resolveNoosphereConfig({ CODEX_NOOSPHERE_TIMEOUT_MS: "60000" }).timeoutMs,
    30_000,
  );
  assert.equal(
    resolveNoosphereConfig({ CODEX_NOOSPHERE_TIMEOUT_MS: "not-a-number" }).timeoutMs,
    5_000,
  );
});
