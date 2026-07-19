#!/usr/bin/env node
import process from "node:process";
import pg from "pg";
import { HYBRID_LIMITS, readBoundedInteger } from "./hybrid-provider.mjs";

const { Pool } = pg;
const databaseUrl = process.env.NOOSPHERE_HYBRID_ADMIN_DATABASE_URL;
if (!databaseUrl) throw new Error("NOOSPHERE_HYBRID_ADMIN_DATABASE_URL is required");
const parsed = new URL(databaseUrl);
if (decodeURIComponent(parsed.username) !== "noosphere_hybrid_admin_login") {
  throw new Error("Hybrid backfill database URL must use noosphere_hybrid_admin_login");
}
const profileId = readArg("--profile");
if (!/^[0-9a-f-]{36}$/iu.test(profileId)) throw new Error("--profile must be a UUID");
const chunkSize = readBoundedInteger(readArg("--chunk", false), "--chunk", HYBRID_LIMITS.backfillChunk);
const once = process.argv.includes("--once");
const pool = new Pool({ connectionString: databaseUrl, max: 1, application_name: "noosphere-hybrid-backfill" });

let totalScanned = 0;
let totalEnqueued = 0;
try {
  do {
    const result = await pool.query(
      `SELECT * FROM noosphere_hybrid_b.enqueue_profile_backfill($1::uuid, $2::integer)`,
      [profileId, chunkSize],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Hybrid backfill returned no progress record");
    const cursor = row.next_cursor;
    totalScanned += Number(row.scanned_count);
    totalEnqueued += Number(row.enqueued_count);
    process.stdout.write(`${JSON.stringify({ profileId, cursor, scanned: totalScanned, enqueued: totalEnqueued, done: row.done })}\n`);
    if (row.done || once) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (true);
} finally {
  await pool.end();
}

function readArg(name, required = true) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (required && !value) throw new Error(`${name} is required`);
  return value;
}
