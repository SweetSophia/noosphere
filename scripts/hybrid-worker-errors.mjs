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

// A dotted name: at least one label separator, every label alphanumeric or
// dash separated. Matching whole tokens rather than substrings is what keeps
// a host from being half redacted.
const HOST_LIKE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)+$/i;
const IP_LIKE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const PORT_SUFFIX = /:\d{1,5}$/;
// Trailing punctuation belongs to the sentence, not to the token.
const TRAILING_PUNCTUATION = /[.,;:!?)\]}"']+$/;
const CREDENTIAL_KEY = /^(?:[a-z0-9_-]*(?:password|passwd|api[_-]?key|token|secret|authorization)[a-z0-9_-]*)$/i;

/**
 * Redacts anything that could carry a credential, a connection string, a host
 * name or an IP address, so a fatal message can be logged without leaking
 * secrets.
 *
 * Two passes, because the two kinds of secret sit at different granularities:
 *
 * 1. Credentials and URLs are matched across the whole message, since a
 *    credential can be introduced by a key and completed by a later token
 *    ("authorization: Bearer <token>").
 * 2. Hosts and addresses are matched token by token, and a host token is
 *    replaced in full. Removing a host as a substring would leave the
 *    remainder of the name behind, so "internal.example.com" could still
 *    surface as "internal.example.".
 */
export function sanitizeErrorMessage(message) {
  if (typeof message !== "string" || message.length === 0) return null;
  const withoutSecrets = message
    // Keep the scheme so the log still records what kind of URL failed.
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/giu, "postgres://<redacted>")
    .replace(/\b([a-z][a-z0-9+.-]*):\/\/[^\s"']+/giu, "$1://<redacted-url>")
    .replace(
      /(\b(?:password|passwd|api[_-]?key|token|secret|authorization)\b\s*[=:]\s*)(?:Bearer\s+)?\S+/giu,
      "$1<redacted>",
    );
  const redacted = withoutSecrets
    .split(/(\s+)/)
    .map((token) => (token.trim().length === 0 ? token : redactToken(token)))
    .join("");
  return redacted.slice(0, 300);
}

function redactToken(token) {
  const trailing = TRAILING_PUNCTUATION.exec(token)?.[0] ?? "";
  const core = trailing.length > 0 ? token.slice(0, -trailing.length) : token;
  if (core.length === 0) return token;

  // A URL: keep the scheme so the log still records what kind of URL failed.
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(core);
  if (scheme) return `${scheme[1]}://<redacted-url>${trailing}`;

  // key=value and key: value credentials, including "authorization: Bearer x".
  const credential = /^([a-z0-9_-]+)(\s*[=:]\s*)(.*)$/i.exec(core);
  if (credential && CREDENTIAL_KEY.test(credential[1])) {
    return `${credential[1]}${credential[2]}<redacted>${trailing}`;
  }


  // A host with an optional port, or a bare service name with a port.
  const withoutPort = PORT_SUFFIX.exec(core);
  const hostPart = withoutPort ? core.slice(0, withoutPort.index) : core;
  const portPart = withoutPort ? withoutPort[0] : "";

  if (IP_LIKE.test(hostPart)) return `<redacted-ip>${portPart}${trailing}`;
  if (HOST_LIKE.test(hostPart)) return `<redacted-host>${portPart}${trailing}`;
  if (withoutPort && /^[a-z0-9][a-z0-9_-]*$/i.test(hostPart)) {
    return `<redacted-endpoint>${trailing}`;
  }

  return token;
}
