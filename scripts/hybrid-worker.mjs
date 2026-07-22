#!/usr/bin/env node
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import pg from "pg";
import {
  HYBRID_LIMITS,
  HybridProviderError,
  abortableDelay,
  computeRetryDelayMs,
  parseProviderConfigs,
  providerConfigJsonFromEnv,
  readBoundedInteger,
  requestEmbedding,
  sanitizeErrorCode,
  validateLeaseWindow,
  vectorSqlLiteral,
} from "./hybrid-provider.mjs";

const { Pool } = pg;
const settings = readSettings(process.env);
const providers = parseProviderConfigs(providerConfigJsonFromEnv(process.env));
const pool = new Pool({
  connectionString: settings.databaseUrl,
  max: settings.concurrency + 2,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: "noosphere-hybrid-worker",
});
const shutdown = new AbortController();
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    shutdown.abort(new Error(signal));
    log("info", "worker_shutdown_requested", { signal });
  });
}

try {
  await assertReadiness(pool, providers);
  log("info", "worker_ready", {
    configuredProfiles: providers.size,
    concurrency: settings.concurrency,
    leaseSeconds: settings.leaseSeconds,
    maxAttempts: settings.maxAttempts,
  });
  await writeHealth({ status: "ready", lastSuccessAt: new Date().toISOString() });
  do {
    await assertReadiness(pool, providers);
    const summary = await runBatch();
    const health = await readQueueHealth(pool);
    const severity = queueSeverity(health, settings);
    log(severity === "ok" ? "info" : severity === "warning" ? "warn" : "error", "worker_batch", {
      ...summary,
      queue: health,
      severity,
    });
    await writeHealth({ status: severity, lastSuccessAt: new Date().toISOString(), queue: health, batch: summary });
    if (settings.once || stopping) break;
    await abortableDelay(settings.pollMs, shutdown.signal);
  } while (!stopping);
} catch (error) {
  log("error", "worker_fatal", { code: errorCode(error) });
  await writeHealth({ status: "failed", failedAt: new Date().toISOString(), code: errorCode(error) }).catch(() => {});
  process.exitCode = 1;
} finally {
  shutdown.abort();
  await pool.end().catch(() => {});
}

async function runBatch() {
  const claimed = await pool.query(
    `SELECT * FROM noosphere_hybrid_b.claim_jobs($1, $2, $3, $4::uuid[])`,
    [settings.concurrency, settings.leaseSeconds, settings.maxAttempts, [...providers.keys()]],
  );
  const outcomes = await Promise.all(claimed.rows.map(processJob));
  return {
    claimed: outcomes.length,
    published: outcomes.filter((outcome) => outcome === "published").length,
    retried: outcomes.filter((outcome) => outcome === "retried").length,
    failed: outcomes.filter((outcome) => outcome === "failed").length,
    stale: outcomes.filter((outcome) => outcome === "stale").length,
  };
}

async function processJob(job) {
  const provider = providers.get(job.profile_id);
  if (!provider) {
    await acknowledgeFailure(job, new HybridProviderError("provider_not_configured", "No provider is configured for the claimed profile"));
    return "failed";
  }
  const client = await pool.connect();
  let dispatchTransactionOpen = false;
  try {
    await client.query("BEGIN");
    dispatchTransactionOpen = true;
    const authorization = await client.query(
      `SELECT noosphere_hybrid_b.authorize_dispatch($1::uuid, $2::uuid, $3::bigint) AS authorized`,
      [job.job_id, job.lease_token, job.lease_generation],
    );
    if (!authorization.rows[0]?.authorized) {
      await client.query("COMMIT");
      dispatchTransactionOpen = false;
      await client.query(
        `SELECT noosphere_hybrid_b.release_stale_job($1::uuid, $2::uuid, $3::bigint, $4::integer)`,
        [job.job_id, job.lease_token, job.lease_generation, settings.maxAttempts],
      );
      return "stale";
    }
    // Committing the short authorization transaction is the dispatch
    // linearization point. A revocation that commits first makes authorization
    // false; one that starts afterward cannot retroactively revoke bytes that
    // were already authorized. Provider latency therefore blocks no DB writes.
    await client.query("COMMIT");
    dispatchTransactionOpen = false;
    const embedding = await requestEmbedding(job, provider, {
      timeoutMs: settings.requestTimeoutMs,
      maxResponseBytes: settings.maxResponseBytes,
      signal: shutdown.signal,
    });
    const result = await client.query(
      `SELECT noosphere_hybrid_b.publish_embedding(
         $1::uuid, $2::uuid, $3::bigint, $4::bigint, $5::bytea,
         $6::text::noosphere_vector.vector
       ) AS published`,
      [
        job.job_id,
        job.lease_token,
        job.lease_generation,
        job.claimed_revision,
        job.claimed_content_hash,
        vectorSqlLiteral(embedding),
      ],
    );
    return result.rows[0]?.published ? "published" : "stale";
  } catch (error) {
    if (dispatchTransactionOpen) {
      await client.query("ROLLBACK").catch(() => {});
      dispatchTransactionOpen = false;
    }
    const terminal = !(error instanceof HybridProviderError && error.retryable) || job.attempt_count >= settings.maxAttempts;
    await acknowledgeFailure(job, error, terminal, client);
    return terminal ? "failed" : "retried";
  } finally {
    client.release();
  }
}

async function acknowledgeFailure(job, error, terminal = true, client = pool) {
  const code = errorCode(error);
  const retryAt = new Date(Date.now() + computeRetryDelayMs(job.attempt_count));
  await client.query(
    `SELECT noosphere_hybrid_b.fail_job($1::uuid, $2::uuid, $3::bigint, $4::text, $5::timestamptz, $6::boolean)`,
    [job.job_id, job.lease_token, job.lease_generation, code, retryAt, terminal],
  );
  log(terminal ? "error" : "warn", "worker_job_failed", {
    jobId: job.job_id,
    profileId: job.profile_id,
    attemptCount: job.attempt_count,
    terminal,
    code,
  });
}

export function readSettings(env) {
  const databaseUrl = env.NOOSPHERE_HYBRID_WORKER_DATABASE_URL;
  if (!databaseUrl) throw new Error("NOOSPHERE_HYBRID_WORKER_DATABASE_URL is required");
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("NOOSPHERE_HYBRID_WORKER_DATABASE_URL is invalid");
  }
  if (decodeURIComponent(parsed.username) !== "noosphere_hybrid_worker_login") {
    throw new Error("Hybrid worker database URL must use noosphere_hybrid_worker_login");
  }
  const queueWarningDepth = readBoundedInteger(env.NOOSPHERE_HYBRID_QUEUE_WARNING_DEPTH, "NOOSPHERE_HYBRID_QUEUE_WARNING_DEPTH", HYBRID_LIMITS.queueWarningDepth);
  const queueCriticalDepth = readBoundedInteger(env.NOOSPHERE_HYBRID_QUEUE_CRITICAL_DEPTH, "NOOSPHERE_HYBRID_QUEUE_CRITICAL_DEPTH", HYBRID_LIMITS.queueCriticalDepth);
  const queueWarningAgeSeconds = readBoundedInteger(env.NOOSPHERE_HYBRID_QUEUE_WARNING_AGE_SECONDS, "NOOSPHERE_HYBRID_QUEUE_WARNING_AGE_SECONDS", HYBRID_LIMITS.queueWarningAgeSeconds);
  const queueCriticalAgeSeconds = readBoundedInteger(env.NOOSPHERE_HYBRID_QUEUE_CRITICAL_AGE_SECONDS, "NOOSPHERE_HYBRID_QUEUE_CRITICAL_AGE_SECONDS", HYBRID_LIMITS.queueCriticalAgeSeconds);
  if (queueCriticalDepth <= queueWarningDepth || queueCriticalAgeSeconds <= queueWarningAgeSeconds) {
    throw new Error("Hybrid queue critical thresholds must exceed warning thresholds");
  }
  const leaseSeconds = readBoundedInteger(env.NOOSPHERE_HYBRID_LEASE_SECONDS, "NOOSPHERE_HYBRID_LEASE_SECONDS", HYBRID_LIMITS.leaseSeconds);
  const requestTimeoutMs = readBoundedInteger(env.NOOSPHERE_HYBRID_REQUEST_TIMEOUT_MS, "NOOSPHERE_HYBRID_REQUEST_TIMEOUT_MS", HYBRID_LIMITS.requestTimeoutMs);
  validateLeaseWindow(leaseSeconds, requestTimeoutMs);
  return Object.freeze({
    databaseUrl,
    concurrency: readBoundedInteger(env.NOOSPHERE_HYBRID_WORKER_CONCURRENCY, "NOOSPHERE_HYBRID_WORKER_CONCURRENCY", HYBRID_LIMITS.concurrency),
    leaseSeconds,
    maxAttempts: readBoundedInteger(env.NOOSPHERE_HYBRID_MAX_ATTEMPTS, "NOOSPHERE_HYBRID_MAX_ATTEMPTS", HYBRID_LIMITS.maxAttempts),
    pollMs: readBoundedInteger(env.NOOSPHERE_HYBRID_WORKER_POLL_MS, "NOOSPHERE_HYBRID_WORKER_POLL_MS", HYBRID_LIMITS.pollMs),
    requestTimeoutMs,
    maxResponseBytes: readBoundedInteger(env.NOOSPHERE_HYBRID_MAX_RESPONSE_BYTES, "NOOSPHERE_HYBRID_MAX_RESPONSE_BYTES", HYBRID_LIMITS.responseBytes),
    queueWarningDepth,
    queueCriticalDepth,
    queueWarningAgeSeconds,
    queueCriticalAgeSeconds,
    healthFile: env.NOOSPHERE_HYBRID_WORKER_HEALTH_FILE || "/tmp/noosphere-hybrid-worker/health.json",
    once: process.argv.includes("--once"),
  });
}

async function assertReadiness(clientPool, configuredProviders) {
  const result = await clientPool.query(
    `SELECT current_user AS current_user, readiness.*
     FROM noosphere_hybrid_b.worker_readiness() AS readiness`,
  );
  const row = result.rows[0];
  if (!row || row.current_user !== "noosphere_hybrid_worker_login" || row.feature_version !== 2) {
    throw new Error("Hybrid Phase B database readiness check failed");
  }
  const activeProfileIds = Array.isArray(row.active_profile_ids) ? row.active_profile_ids : [];
  if (activeProfileIds.length !== Number(row.active_profiles) || activeProfileIds.some((profileId) => !configuredProviders.has(profileId))) {
    throw new Error("Every active embedding profile must have a provider configuration");
  }
}

async function readQueueHealth(clientPool) {
  const result = await clientPool.query(`SELECT * FROM noosphere_hybrid_b.queue_health()`);
  const row = result.rows[0] ?? {};
  return {
    pendingDepth: Number(row.pending_depth ?? 0),
    oldestPendingAgeSeconds: Number(row.oldest_pending_age_seconds ?? 0),
    leased: Number(row.leased_count ?? 0),
    terminalFailed: Number(row.failed_count ?? 0),
  };
}

function queueSeverity(health, config) {
  if (health.terminalFailed > 0) return "critical";
  if (health.pendingDepth >= config.queueCriticalDepth || health.oldestPendingAgeSeconds >= config.queueCriticalAgeSeconds) return "critical";
  if (health.pendingDepth >= config.queueWarningDepth || health.oldestPendingAgeSeconds >= config.queueWarningAgeSeconds) return "warning";
  return "ok";
}

async function writeHealth(payload) {
  const path = settings.healthFile;
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function log(level, event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields })}\n`);
}

function errorCode(error) {
  if (error instanceof HybridProviderError) return sanitizeErrorCode(error.code);
  if (error && typeof error === "object" && typeof error.code === "string") {
    return sanitizeErrorCode(`database_${error.code}`);
  }
  return "worker_internal";
}
