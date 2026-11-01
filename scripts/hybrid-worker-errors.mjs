// Classification and redaction helpers for fatal worker errors.
//
// The worker logs a fatal stop as a single "code". That code alone collapses
// every distinct cause into one opaque value, so an operator reading the log
// after a crash cannot tell a readiness assertion from a pool timeout from a
// programming error. These helpers keep the code stable (so existing
// alerting keeps matching) while adding the kind and a redacted message that
// actually make the fault diagnosable.
//
// This module is deliberately free of side effects so it can be unit tested
// without a database.

import { HybridProviderError, sanitizeErrorCode } from "./hybrid-provider.mjs";

/**
 * Stable error code. Existing values are unchanged; new values are only added
 * for failure modes that previously collapsed into "worker_internal".
 */
export function workerErrorCode(error) {
  if (error instanceof HybridProviderError) return sanitizeErrorCode(error.code);
  if (error && typeof error === "object" && typeof error.code === "string") {
    return sanitizeErrorCode(`database_${error.code}`);
  }
  return "worker_internal";
}

/**
 * The error kind separates failure modes that share a code. This is what
 * tells an operator where to look after a fatal stop.
 */
export function workerErrorKind(error) {
  if (error instanceof HybridProviderError) return "provider";
  if (error?.name === "AggregateError") return "pool_aggregate";
  if (error?.name === "AbortError") return "aborted";
  if (error?.name === "TypeError" || error?.name === "RangeError") return "programming";
  if (error && typeof error === "object" && typeof error.code === "string") return "database";
  const message = typeof error?.message === "string" ? error.message : "";
  if (message.includes("readiness check failed")) return "readiness";
  if (message.includes("must have a provider configuration")) return "readiness";
  return "internal";
}

/**
 * Redacts anything that could carry a credential, a connection string, a host
 * name or an IP address, so a fatal message can be logged without leaking
 * secrets.
 */
export function sanitizeErrorMessage(message) {
  if (typeof message !== "string" || message.length === 0) return null;
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/giu, "postgres://<redacted>")
    .replace(/\b[a-z0-9_-]{2,}:\/\/[^\s"']+/giu, "<redacted-url>")
    .replace(/(\b(?:password|api[_-]?key|token|secret|authorization)\b\s*[=:]\s*)(?:Bearer\s+)?\S+/giu, "$1<redacted>")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, "<redacted-ip>")
    .replace(/[a-z0-9.-]+\.(?:internal|local|com|net|org|io)\b/giu, "<redacted-host>")
    .slice(0, 300);
}
