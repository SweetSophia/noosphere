// Side-effect-free classification and redaction for fatal worker diagnostics.
import { isIP } from "node:net";
import { HybridProviderError, sanitizeErrorCode } from "./hybrid-provider.mjs";

// Classification must not depend on the human-facing wording of an assertion.
export class HybridWorkerReadinessError extends Error {}
export class HybridWorkerConfigError extends Error {}

/** Keep existing codes stable, including the historical database_ prefix. */
export function workerErrorCode(error) {
  if (error instanceof HybridWorkerConfigError) return workerErrorCode(error.cause);
  if (error instanceof HybridProviderError) return sanitizeErrorCode(error.code);
  if (error && typeof error === "object" && typeof error.code === "string") {
    return sanitizeErrorCode(`database_${error.code}`);
  }
  return "worker_internal";
}

const FILESYSTEM_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ENOSPC", "EROFS", "EISDIR", "ENOTDIR", "EMFILE", "ENFILE"]);
const FILESYSTEM_SYSCALL = /^(?:mkdir|open|write|writeFile|rename|stat|lstat|unlink|fsync)$/;

export function workerErrorKind(error) {
  if (error instanceof HybridWorkerConfigError) return "configuration";
  if (error instanceof HybridProviderError) return "provider";
  if (error instanceof HybridWorkerReadinessError) return "readiness";
  if (error?.name === "AggregateError") return "pool_aggregate";
  if (error?.name === "AbortError") return "aborted";
  if (error?.name === "TypeError" || error?.name === "RangeError") return "programming";
  if (FILESYSTEM_CODES.has(error?.code) || (typeof error?.path === "string" && FILESYSTEM_SYSCALL.test(error?.syscall ?? ""))) return "filesystem";
  if (error && typeof error === "object" && typeof error.code === "string") return "database";
  return "internal";
}

/** Include at most four direct AggregateError children; never recurse into cycles. */
export function workerErrorMessage(error) {
  const messages = [];
  if (typeof error?.message === "string" && error.message) messages.push(error.message);
  if (error?.name === "AggregateError" && Array.isArray(error.errors)) {
    for (const child of error.errors.slice(0, 4)) {
      const code = typeof child?.code === "string" ? sanitizeErrorCode(child.code).toUpperCase() : "";
      const message = typeof child?.message === "string" ? child.message : "";
      if (code || message) messages.push(`${code}${code && message ? ": " : ""}${message}`);
    }
  }
  // Sanitize each message separately: an unterminated credential in one child
  // must not use a quote in the next child to close its value.
  return messages.map(sanitizeErrorMessage).filter(Boolean).join("; ").slice(0, 300) || null;
}

const HOST_LIKE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)+$/i;
const PORT_OR_PATH = /(?::\d{1,5})?(?:\/\S*)?$/;
const LEADING_PUNCTUATION = /^[({["']+/;
const TRAILING_PUNCTUATION = /[.,;!?)\]}"']+$/;
// Quoted values may contain spaces and escapes. An unclosed quote consumes the
// remainder instead of exposing the tail of a malformed credential. Digest's
// comma-separated parameters are conservatively removed to end of line.
const CREDENTIAL = /(\b[a-z0-9_-]*(?:password|passwd|api[_-]?key|token|secret|authorization)[a-z0-9_-]*["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|(?:Bearer|Basic|Negotiate)\s+[^\s,;}]+|Digest[^\r\n]*|[^\s,;}]+)/giu;

/**
 * Redact common structured credentials and network endpoint forms before
 * truncation. This is not a general-purpose detector of arbitrary secrets in
 * prose: callers must not log raw configuration or other sensitive payloads.
 * Ambiguous dotted words (including filenames) remain conservatively redacted;
 * a TLD allowlist or file-extension exception would also allow real hosts.
 */
export function sanitizeErrorMessage(message) {
  if (typeof message !== "string" || message.length === 0) return null;
  const withoutSecrets = message.slice(0, 8192)
    // A quoted connection URI can include spaces in its password. Consume its
    // complete quoted value before handling ordinary non-whitespace URLs.
    .replace(/"([a-z][a-z0-9+.-]*):\/\/(?:\\.|[^"\\])*(?:"|$)/giu, (_, scheme) => `"${/^postgres(?:ql)?$/i.test(scheme) ? "postgres" : scheme}://<redacted-url>"`)
    .replace(/'([a-z][a-z0-9+.-]*):\/\/(?:\\.|[^'\\])*(?:'|$)/giu, (_, scheme) => `'${/^postgres(?:ql)?$/i.test(scheme) ? "postgres" : scheme}://<redacted-url>'`)
    .replace(/\b([a-z][a-z0-9+.-]*):\/\/(?!<redacted-url>)[^\s]+/giu, (_, scheme) => `${/^postgres(?:ql)?$/i.test(scheme) ? "postgres" : scheme}://<redacted-url>`)
    .replace(CREDENTIAL, "$1<redacted>")
    // PostgreSQL also prints quoted single-label hosts outside DNS errors.
    .replace(/(\bserver at\s+)(["'])([a-z0-9_-]+)\2/giu, "$1$2<redacted-endpoint>$2")
    // Endpoint operands have a known position even for single-label hosts.
    .replace(/\b(getaddrinfo\s+\S+\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, "$1<redacted-endpoint>")
    .replace(/\b(connect\s+E[A-Z0-9_]+\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gu, "$1<redacted-endpoint>");
  return withoutSecrets.split(/(\s+)/)
    .map((token) => token.trim() ? redactToken(token) : token)
    .join("").slice(0, 300);
}

function redactToken(token) {
  const leading = LEADING_PUNCTUATION.exec(token)?.[0] ?? "";
  const remainder = token.slice(leading.length);
  const trailing = TRAILING_PUNCTUATION.exec(remainder)?.[0] ?? "";
  const core = trailing ? remainder.slice(0, -trailing.length) : remainder;
  if (!core) return token;

  // Remove the entire endpoint, port and path consistently. Bracketed IPv6
  // may retain a closing bracket in core when followed by a port.
  const ipv6Core = core.replace(/\](?::\d{1,5})?(?:\/\S*)?$/, "");
  if (isIP(ipv6Core)) return `${leading}<redacted-ip>${core.includes("]") ? "]" : ""}${trailing}`;
  // Scheme-less userinfo and malformed URL tails can still carry credentials.
  // A network-looking authority after @ is enough to discard the whole token.
  const authority = core.slice(core.lastIndexOf("@") + 1).replace(PORT_OR_PATH, "");
  if (core.includes("@") && (HOST_LIKE.test(authority) || isIP(authority) || /^[a-z0-9][a-z0-9_-]*$/i.test(authority))) {
    return `${leading}<redacted-endpoint>${trailing}`;
  }
  const endpoint = core.replace(PORT_OR_PATH, "");
  if (isIP(endpoint)) return `${leading}<redacted-ip>${trailing}`;
  // Numeric diagnostics and versions aren't DNS names; do not erase them.
  if (/^v?\d+(?:\.\d+)+$/i.test(core) || /^(?:e\.g|i\.e)$/i.test(core)) return token;
  if (HOST_LIKE.test(endpoint)) return `${leading}<redacted-host>${trailing}`;
  if (endpoint !== core && /^[a-z0-9][a-z0-9_-]*$/i.test(endpoint)) return `${leading}<redacted-endpoint>${trailing}`;
  return token;
}
