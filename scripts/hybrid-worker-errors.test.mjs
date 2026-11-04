import assert from "node:assert/strict";
import test from "node:test";
import { HybridProviderError } from "./hybrid-provider.mjs";
import {
  HybridWorkerReadinessError,
  sanitizeErrorMessage,
  workerErrorCode,
  workerErrorMessage,
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
  assert.equal(workerErrorKind(new HybridWorkerReadinessError("Hybrid Phase B database readiness check failed")), "readiness");
  assert.equal(
    workerErrorKind(new HybridWorkerReadinessError("Every active embedding profile must have a provider configuration")),
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
    "host <redacted-host>",
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
    "failure at <redacted-ip>",
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

for (const [name, input, expected] of [
  ["DNS service name", "getaddrinfo EAI_AGAIN db", "getaddrinfo EAI_AGAIN <redacted-endpoint>"],
  ["unlisted DNS suffix", "getaddrinfo ENOTFOUND database.example.dev", "getaddrinfo ENOTFOUND <redacted-endpoint>"],
  ["endpoint path", "connect ECONNREFUSED db:5432/noosphere", "connect ECONNREFUSED <redacted-endpoint>"],
  ["IPv6", "connect ECONNREFUSED 2001:db8::10:5432", "connect ECONNREFUSED <redacted-endpoint>"],
  ["bracketed IPv6", "connect ECONNREFUSED [2001:db8::10]:5432", "connect ECONNREFUSED <redacted-endpoint>"],
  ["mapped IPv6", "failure at ::ffff:192.0.2.1", "failure at <redacted-ip>"],
  ["compressed IPv6", "failure at ::1", "failure at <redacted-ip>"],
  ["quoted host", 'server at "database.example.cloud"', 'server at "<redacted-host>"'],
  ["parenthesized IP", "server (192.0.2.10), port 5432", "server (<redacted-ip>), port 5432"],
  ["quoted host and port", 'server "database.example.cloud:8080"', 'server "<redacted-host>"'],
  ["quoted URL password", "postgresql://user:PLACEHOLDER'VALUE@db:5432/wiki", "postgres://<redacted-url>"],
  ["JSON API key", '{"api_key":"PLACEHOLDER_VALUE"}', '{"api_key":<redacted>}'],
  ["JSON authorization", '{"authorization": "Bearer PLACEHOLDER_VALUE"}', '{"authorization": <redacted>}'],
  ["quoted spaced password", 'password="PLACEHOLDER ONE"', 'password=<redacted>'],
  ["single quoted password", "password='PLACEHOLDER TWO'", "password=<redacted>"],
  ["Basic authorization", "authorization: Basic PLACEHOLDER_VALUE", "authorization: <redacted>"],
  ["Digest authorization", 'authorization: Digest username="EXAMPLE", response="PLACEHOLDER"', "authorization: <redacted>"],
  ["Negotiate authorization", "authorization: Negotiate PLACEHOLDER_VALUE", "authorization: <redacted>"],
  ["version and decimal", "Node v20.11.0 timeout 1.5 seconds", "Node v20.11.0 timeout 1.5 seconds"],
]) {
  test(`sanitizeErrorMessage regression: ${name}`, () => {
    assert.equal(sanitizeErrorMessage(input), expected);
  });
}

test("filesystem classification preserves legacy code while correcting kind", () => {
  for (const code of ["ENOENT", "EACCES", "ENOSPC", "EROFS", "EISDIR"]) {
    const error = Object.assign(new Error("health file failed"), { code, syscall: "open", path: "/fixture/health" });
    assert.equal(workerErrorKind(error), "filesystem");
    assert.equal(workerErrorCode(error), `database_${code.toLowerCase()}`);
  }
  assert.equal(workerErrorKind(Object.assign(new Error("disk"), { code: "EIO", syscall: "write", path: "/fixture/health" })), "filesystem");
});

test("readiness classification uses an explicit error type independent of wording", async () => {
  const helpers = await import("./hybrid-worker-errors.mjs");
  assert.equal(typeof helpers.HybridWorkerReadinessError, "function");
  const error = new helpers.HybridWorkerReadinessError("Changed wording");
  assert.equal(workerErrorKind(error), "readiness");
  assert.equal(workerErrorCode(error), "worker_internal");
});

test("empty AggregateError includes bounded sanitized child diagnostics", async () => {
  const { workerErrorMessage } = await import("./hybrid-worker-errors.mjs");
  assert.equal(typeof workerErrorMessage, "function");
  const error = new AggregateError([
    Object.assign(new Error("connect ECONNREFUSED [2001:db8::10]:5432"), { code: "ECONNREFUSED" }),
    Object.assign(new Error("connect ETIMEDOUT db:5432"), { code: "ETIMEDOUT" }),
  ], "");
  assert.equal(workerErrorKind(error), "pool_aggregate");
  assert.equal(workerErrorMessage(error), "ECONNREFUSED: connect ECONNREFUSED <redacted-endpoint>; ETIMEDOUT: connect ETIMEDOUT <redacted-endpoint>");
  const many = new AggregateError(Array.from({ length: 20 }, () => new Error("x".repeat(200))), "");
  assert.ok(workerErrorMessage(many).length <= 300);
  const circular = new AggregateError([], "");
  circular.errors.push(circular);
  assert.equal(workerErrorMessage(circular), null);
});

test("production runner copies the worker's complete local import graph", async () => {
  const { readFile, mkdtemp, mkdir, copyFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const root = new URL("../", import.meta.url);
  const dockerfile = await readFile(new URL("Dockerfile", root), "utf8");
  const runner = dockerfile.split("FROM base AS runner")[1];
  const temporary = await mkdtemp(join(tmpdir(), "worker-image-imports-"));
  try {
    for (const match of runner.matchAll(/^COPY --from=builder(?: --chown=\S+)? \/app\/(scripts\/\S+\.mjs) \.\/(scripts\/\S+\.mjs)$/gm)) {
      const target = join(temporary, match[2]);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(new URL(match[1], root), target);
    }
    // Walk from the actual worker entrypoint, including transitive local imports.
    async function check(relative) {
      const source = await readFile(join(temporary, relative), "utf8");
      for (const match of source.matchAll(/from "\.\/([^"\n]+\.mjs)"/g)) await check(join(dirname(relative), match[1]));
    }
    await check("scripts/hybrid-worker.mjs");
    const helpers = await import(pathToFileURL(join(temporary, "scripts/hybrid-worker-errors.mjs")));
    assert.equal(helpers.workerErrorCode(new Error()), "worker_internal");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("root CI explicitly runs the worker diagnostics suite", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /run: npm run test:hybrid-worker-errors\s*\n/);
});

test("configuration errors use the fatal handler before opening a database", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["scripts/hybrid-worker.mjs", "--once"], {
    cwd: new URL("../", import.meta.url),
    env: { PATH: process.env.PATH, NOOSPHERE_HYBRID_WORKER_DATABASE_URL: "" },
    encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.event, "worker_fatal");
  assert.equal(payload.code, "worker_internal");
  assert.equal(payload.kind, "configuration");
  assert.equal(payload.message, "NOOSPHERE_HYBRID_WORKER_DATABASE_URL is required");
});

for (const [name, input, expected] of [
  ["quoted PostgreSQL service", 'connection to server at "db" (192.0.2.1), port 5432 failed', 'connection to server at "<redacted-endpoint>" (<redacted-ip>), port 5432 failed'],
  ["unclosed credential", 'password="PLACEHOLDER ONE', 'password=<redacted>'],
  ["JSON spaced connection URL", '{"url":"postgresql://user:PLACEHOLDER ONE@db/wiki"}', '{"url":"postgres://<redacted-url>"}'],
  ["quoted bracketed IPv6", 'failure at "[::1]:5432"', 'failure at "[<redacted-ip>]"'],
  ["numeric diagnostic in prose", 'E.g. Node v20.11.0, timeout 1.5 seconds', 'E.g. Node v20.11.0, timeout 1.5 seconds'],
]) test(`sanitizeErrorMessage boundary: ${name}`, () => assert.equal(sanitizeErrorMessage(input), expected));

test("TCP write failures are database failures, not health-file failures", () => {
  for (const code of ["ECONNRESET", "EPIPE"]) {
    const error = Object.assign(new Error("socket ended"), { code, syscall: "write" });
    assert.equal(workerErrorKind(error), "database");
    assert.equal(workerErrorCode(error), `database_${code.toLowerCase()}`);
  }
});

test("scheme-less userinfo and a spaced URL tail are redacted", () => {
  assert.equal(sanitizeErrorMessage("failed user:PLACEHOLDER@db.internal.example.com:5432/prod"), "failed <redacted-endpoint>");
  assert.equal(sanitizeErrorMessage("failed user:PLACEHOLDER@db:5432/prod"), "failed <redacted-endpoint>");
  assert.equal(sanitizeErrorMessage("http://user:PLACEHOLDER ONE@db:5432/wiki"), "http://<redacted-url> <redacted-endpoint>");
});

for (const [name, overrides, expected] of [
  ["invalid database URL", { NOOSPHERE_HYBRID_WORKER_DATABASE_URL: "not-a-url" }, "NOOSPHERE_HYBRID_WORKER_DATABASE_URL is invalid"],
  ["invalid bound", { NOOSPHERE_HYBRID_WORKER_CONCURRENCY: "0" }, "NOOSPHERE_HYBRID_WORKER_CONCURRENCY must be an integer between 1 and 16"],
  ["invalid provider JSON", { NOOSPHERE_HYBRID_PROVIDER_CONFIG_JSON: "not-json" }, "NOOSPHERE_HYBRID_PROVIDER_CONFIG_JSON must be valid JSON"],
  ["invalid provider base64", { NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64: "!" }, "NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64 must be canonical base64"],
]) test(`configuration kind before DB startup: ${name}`, async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtemp, rm, access } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const temporary = await mkdtemp(join(tmpdir(), "worker-config-"));
  const healthFile = join(temporary, "health.json");
  try {
    const result = spawnSync(process.execPath, ["scripts/hybrid-worker.mjs", "--once"], {
      cwd: new URL("../", import.meta.url),
      env: { PATH: process.env.PATH,
        NOOSPHERE_HYBRID_WORKER_DATABASE_URL: "postgresql://noosphere_hybrid_worker_login@127.0.0.1:1/fixture",
        NOOSPHERE_HYBRID_WORKER_HEALTH_FILE: healthFile, ...overrides },
      encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const fatal = JSON.parse(result.stdout.trim());
    assert.equal(fatal.event, "worker_fatal");
    assert.equal(fatal.kind, "configuration");
    assert.equal(fatal.code, "worker_internal");
    assert.equal(fatal.message, expected);
    // Invalid configuration never reaches pool creation or health-file writes.
    await assert.rejects(access(healthFile), { code: "ENOENT" });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("typed configuration failures preserve the existing configuration code", async () => {
  const { HybridWorkerConfigError } = await import("./hybrid-worker-errors.mjs");
  assert.equal(typeof HybridWorkerConfigError, "function");
  for (const cause of [new Error("invalid config"), null, "invalid config"]) {
    const error = new HybridWorkerConfigError(cause?.message, { cause });
    assert.equal(workerErrorKind(error), "configuration");
    assert.equal(workerErrorCode(error), "worker_internal");
  }
});


test("configuration code lookup is bounded even for cyclic causes", async () => {
  const { HybridWorkerConfigError } = await import("./hybrid-worker-errors.mjs");
  const error = new HybridWorkerConfigError("invalid config");
  error.cause = error;
  assert.equal(workerErrorCode(error), "worker_internal");
});

test("typed worker errors have diagnostic names", async () => {
  const { HybridWorkerConfigError } = await import("./hybrid-worker-errors.mjs");
  assert.equal(new HybridWorkerConfigError("invalid").name, "HybridWorkerConfigError");
  assert.equal(new HybridWorkerReadinessError("not ready").name, "HybridWorkerReadinessError");
});

test("parser programming failures retain their programming kind", async () => {
  const { HybridWorkerConfigError } = await import("./hybrid-worker-errors.mjs");
  for (const cause of [new TypeError("parser failed"), new RangeError("parser failed")]) {
    assert.equal(workerErrorKind(new HybridWorkerConfigError(cause.message, { cause })), "programming");
  }
});

test("configuration wrapper tolerates non-Error thrown values without serializing raw objects", async () => {
  const { HybridWorkerConfigError } = await import("./hybrid-worker-errors.mjs");
  for (const cause of [null, undefined, "invalid config", { toString() { throw new Error("unsafe coercion"); } }]) {
    const error = new HybridWorkerConfigError(undefined, { cause });
    assert.equal(workerErrorMessage(error), "Hybrid worker configuration parsing failed");
  }
});

test("valid configuration leaves connection failures classified as database", async () => {
  const { createServer } = await import("node:net");
  const { spawnSync } = await import("node:child_process");
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const temporary = await mkdtemp(join(tmpdir(), "worker-runtime-"));
  try {
    const healthFile = join(temporary, "health.json");
    const result = spawnSync(process.execPath, ["scripts/hybrid-worker.mjs", "--once"], {
      cwd: new URL("../", import.meta.url),
      env: { PATH: process.env.PATH,
        NOOSPHERE_HYBRID_WORKER_DATABASE_URL: `postgresql://noosphere_hybrid_worker_login@127.0.0.1:${port}/fixture`,
        NOOSPHERE_HYBRID_WORKER_HEALTH_FILE: healthFile },
      encoding: "utf8", timeout: 10000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, "");
    const fatal = JSON.parse(result.stdout.trim());
    assert.equal(fatal.kind, "database");
    assert.equal(fatal.code, "database_econnrefused");
    const health = JSON.parse(await readFile(healthFile, "utf8"));
    assert.equal(health.kind, "database");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
