#!/usr/bin/env node
import process from "node:process";
import pg from "pg";
import { endpointIdentitySha256 } from "./hybrid-provider.mjs";

const { Pool } = pg;
const databaseUrl = process.env.NOOSPHERE_HYBRID_ADMIN_DATABASE_URL;
if (!databaseUrl) throw new Error("NOOSPHERE_HYBRID_ADMIN_DATABASE_URL is required");
const parsedUrl = new URL(databaseUrl);
if (decodeURIComponent(parsedUrl.username) !== "noosphere_hybrid_admin_login") {
  throw new Error("Hybrid profile administration must use noosphere_hybrid_admin_login");
}
const command = process.argv[2];
const pool = new Pool({ connectionString: databaseUrl, max: 1, application_name: "noosphere-hybrid-profile-admin" });

try {
  if (command === "create") {
    const locality = arg("--locality");
    const endpoint = arg("--endpoint");
    const result = await pool.query(
      `SELECT noosphere_hybrid_b.create_profile(
         'openai-compatible', $1::noosphere_hybrid.profile_locality,
         $2::text, $3::text, $4::integer,
         $5::noosphere_hybrid.distance_metric,
         $6::noosphere_hybrid.normalization_policy,
         $7::integer, decode($8::text, 'hex')
       ) AS profile_id`,
      [
        locality,
        arg("--model"),
        arg("--revision"),
        Number(arg("--dimensions")),
        arg("--distance", false) || "cosine",
        arg("--normalization", false) || "none",
        Number(arg("--max-input-bytes", false) || 32_768),
        endpointIdentitySha256(endpoint, locality),
      ],
    );
    process.stdout.write(`${JSON.stringify({ profileId: result.rows[0].profile_id })}\n`);
  } else if (command === "consent") {
    const remote = booleanArg("--remote");
    const restricted = booleanArg("--restricted-remote");
    await pool.query(`SELECT noosphere_hybrid_b.set_embedding_consent($1, $2)`, [remote, restricted]);
    process.stdout.write(`${JSON.stringify({ remoteEgress: remote, restrictedRemoteEgress: restricted })}\n`);
  } else if (["prepare", "serve", "deactivate"].includes(command)) {
    const target = command === "prepare" ? "preparing" : command === "serve" ? "serving" : "inactive";
    const profileId = arg("--profile");
    await pool.query(
      `SELECT noosphere_hybrid_b.set_profile_state($1::uuid, $2::noosphere_hybrid.profile_state)`,
      [profileId, target],
    );
    process.stdout.write(`${JSON.stringify({ profileId, state: target })}\n`);
  } else if (command === "status") {
    const profileId = arg("--profile");
    const result = await pool.query(
      `SELECT * FROM noosphere_hybrid_b.profile_status($1::uuid)`,
      [profileId],
    );
    if (!result.rows[0]) throw new Error("Embedding profile does not exist");
    process.stdout.write(`${JSON.stringify(result.rows[0])}\n`);
  } else {
    throw new Error("usage: hybrid-profile.mjs create|consent|prepare|serve|deactivate|status [options]");
  }
} finally {
  await pool.end();
}

function arg(name, required = true) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (required && !value) throw new Error(`${name} is required`);
  return value;
}

function booleanArg(name) {
  const value = arg(name);
  if (!['true', 'false'].includes(value)) throw new Error(`${name} must be true or false`);
  return value === "true";
}
