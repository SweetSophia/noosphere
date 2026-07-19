#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const path = process.env.NOOSPHERE_HYBRID_WORKER_HEALTH_FILE || "/tmp/noosphere-hybrid-worker/health.json";
const maximumAgeMs = 120_000;
try {
  const health = JSON.parse(await readFile(path, "utf8"));
  const timestamp = Date.parse(health.lastSuccessAt);
  if (!Number.isFinite(timestamp) || Date.now() - timestamp > maximumAgeMs || health.status === "failed" || health.status === "critical") {
    process.exit(1);
  }
} catch {
  process.exit(1);
}
