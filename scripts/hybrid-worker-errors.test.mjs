import assert from "node:assert/strict";
import test from "node:test";
import { HybridProviderError } from "./hybrid-provider.mjs";
import {
  sanitizeErrorMessage,
  workerErrorCode,
  workerErrorKind,
} from "./hybrid-worker-errors.mjs";

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

test("sanitizeErrorMessage redacts connection strings and credentials", () => {
  const sanitized = sanitizeErrorMessage(
    "connect ECONNREFUSED postgresql://worker_login:placeholder@db:5432/noosphere password=placeholder",
  );
  assert.ok(sanitized);
  assert.ok(!sanitized.includes("placeholder"), "password from a connection string must not survive");
  assert.ok(!sanitized.includes("hunter2"), "password= value must not survive");
  assert.ok(!sanitized.includes("db:5432"), "host:port must not survive");
});

test("sanitizeErrorMessage redacts host names and IP addresses", () => {
  assert.ok(!sanitizeErrorMessage("failure talking to internal.example.com").includes("internal.example.com"));
  // 192.0.2.0/24 is the RFC 5737 documentation range: a placeholder, never a
  // real host address.
  assert.ok(!sanitizeErrorMessage("failure at 192.0.2.10:22").includes("192.0.2.10"));
});

test("sanitizeErrorMessage redacts bearer tokens and api keys", () => {
  assert.ok(!sanitizeErrorMessage("authorization: Bearer abc123def456").includes("abc123def456"));
  assert.ok(!sanitizeErrorMessage("api_key=sk-live-abcdef123456").includes("sk-live-abcdef123456"));
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
