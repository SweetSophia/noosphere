import assert from "node:assert/strict";
import test from "node:test";
import { HybridProviderError } from "./hybrid-provider.mjs";
import {
  sanitizeErrorMessage,
  workerErrorCode,
  workerErrorKind,
} from "./hybrid-worker-errors.mjs";

// The redaction assertions compare the whole output against an expected
// string rather than checking for the absence of a fragment. An exact match
// proves every secret is gone, and it avoids asserting on the presence of a
// host or credential inside a redacted value.

test("workerErrorCode keeps the provider code for provider failures", () => {
  const error = new HybridProviderError("provider_timeout", "Embedding provider request timed out");
  assert.equal(workerErrorCode(error), "provider_timeout");
});

test("workerErrorCode keeps the database code for database failures", () => {
  const error = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
  assert.equal(workerErrorCode(error), "database_econnrefused");
});

test("workerErrorCode is stable for unknown failures", () => {
  assert.equal(workerErrorCode(new Error("boom")), "worker_internal");
  assert.equal(workerErrorCode(undefined), "worker_internal");
  assert.equal(workerErrorCode(null), "worker_internal");
});

test("workerErrorKind separates failure modes that share a code", () => {
  // All three of these map to "worker_internal", so only the kind tells an
  // operator where to look after a fatal stop.
  assert.equal(workerErrorKind(new Error("Hybrid Phase B database readiness check failed")), "readiness");
  assert.equal(
    workerErrorKind(new Error("Every active embedding profile must have a provider configuration")),
    "readiness",
  );
  assert.equal(workerErrorKind(new TypeError("Cannot read properties of undefined")), "programming");
  assert.equal(workerErrorKind(new RangeError("out of range")), "programming");
  assert.equal(workerErrorKind(Object.assign(new Error("pool timeout"), { name: "AggregateError" })), "pool_aggregate");
  assert.equal(workerErrorKind(Object.assign(new Error("aborted"), { name: "AbortError" })), "aborted");
  assert.equal(workerErrorKind(Object.assign(new Error("db"), { code: "ECONNRESET" })), "database");
  assert.equal(workerErrorKind(new HybridProviderError("provider_timeout", "timed out")), "provider");
  assert.equal(workerErrorKind(new Error("something else")), "internal");
});

test("workerErrorKind does not throw on non-error input", () => {
  for (const value of [undefined, null, 0, "", {}, [], "text"]) {
    assert.equal(typeof workerErrorKind(value), "string");
  }
});

test("sanitizeErrorMessage redacts a connection string whole", () => {
  assert.equal(
    sanitizeErrorMessage("postgresql://worker_login:PLACEHOLDERSECRET@db:5432/noosphere"),
    "postgres://<redacted-url>",
  );
});

test("sanitizeErrorMessage redacts a URL whole but keeps the scheme", () => {
  assert.equal(
    sanitizeErrorMessage("connect failed against http://example.invalid/path"),
    "connect failed against http://<redacted-url>",
  );
});

test("sanitizeErrorMessage redacts a host without leaving a partial host behind", () => {
  // A substring redaction would leave "internal.example." behind, which is
  // still most of the host name.
  assert.equal(
    sanitizeErrorMessage("failure talking to internal.example.com"),
    "failure talking to <redacted-host>",
  );
});

test("sanitizeErrorMessage redacts a host that carries a port", () => {
  assert.equal(
    sanitizeErrorMessage("host internal.example.com:8080"),
    "host <redacted-host>:8080",
  );
});

test("sanitizeErrorMessage redacts a bare service name with a port", () => {
  assert.equal(
    sanitizeErrorMessage("connect ECONNREFUSED db:5432"),
    "connect ECONNREFUSED <redacted-endpoint>",
  );
});

test("sanitizeErrorMessage redacts an IP address", () => {
  // 192.0.2.0/24 is the RFC 5737 documentation range: a placeholder, never a
  // real host address.
  assert.equal(
    sanitizeErrorMessage("failure at 192.0.2.10:22"),
    "failure at <redacted-ip>:22",
  );
});

test("sanitizeErrorMessage redacts bearer tokens and api keys", () => {
  assert.equal(
    sanitizeErrorMessage("authorization: Bearer PLACEHOLDERSECRET"),
    "authorization: <redacted>",
  );
  assert.equal(
    sanitizeErrorMessage("api_key=PLACEHOLDERSECRET"),
    "api_key=<redacted>",
  );
  assert.equal(
    sanitizeErrorMessage("password=PLACEHOLDERSECRET"),
    "password=<redacted>",
  );
});

test("sanitizeErrorMessage keeps a useful plain message intact", () => {
  assert.equal(
    sanitizeErrorMessage("Hybrid Phase B database readiness check failed"),
    "Hybrid Phase B database readiness check failed",
  );
});

test("sanitizeErrorMessage returns null for empty or non-string input", () => {
  assert.equal(sanitizeErrorMessage(undefined), null);
  assert.equal(sanitizeErrorMessage(null), null);
  assert.equal(sanitizeErrorMessage(""), null);
  assert.equal(sanitizeErrorMessage(42), null);
});

test("sanitizeErrorMessage bounds the message length", () => {
  assert.ok(sanitizeErrorMessage("x".repeat(1000)).length <= 300);
});
