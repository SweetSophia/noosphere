#!/usr/bin/env node

import process from "node:process";
import pg from "pg";

const { Pool } = pg;

function requiredUrl(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function queryOne(connectionString, statement) {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const result = await pool.query(statement);
    return result.rows[0];
  } finally {
    await pool.end();
  }
}

async function main() {
  const bootstrapUrl = requiredUrl("NOOSPHERE_BOOTSTRAP_DATABASE_URL");
  const appUrl = requiredUrl("NOOSPHERE_APP_DATABASE_URL");
  const migrationUrl = requiredUrl("DATABASE_URL");

  const optionalState = await queryOne(
    bootstrapUrl,
    `
      SELECT
        (SELECT count(*)::integer
         FROM pg_catalog.pg_extension
         WHERE extname IN ('vector', 'pgcrypto')) AS extension_count,
        (SELECT count(*)::integer
         FROM pg_catalog.pg_namespace
         WHERE nspname IN ('noosphere_vector', 'noosphere_crypto', 'noosphere_hybrid')) AS schema_count,
        pg_catalog.has_schema_privilege('noosphere_app', 'public', 'CREATE') AS app_can_create,
        pg_catalog.has_schema_privilege('noosphere_migrator', 'public', 'CREATE') AS migrator_can_create
    `,
  );
  if (optionalState.extension_count !== 0 || optionalState.schema_count !== 0) {
    throw new Error("keyword-only runtime unexpectedly created optional hybrid storage");
  }
  if (optionalState.app_can_create || !optionalState.migrator_can_create) {
    throw new Error("application and migration DDL privileges are not separated");
  }

  const appIdentity = await queryOne(appUrl, "SELECT current_user AS role_name");
  const migrationIdentity = await queryOne(migrationUrl, "SELECT current_user AS role_name");
  if (appIdentity.role_name !== "noosphere_app") {
    throw new Error(`application URL authenticated as ${appIdentity.role_name}`);
  }
  if (migrationIdentity.role_name !== "noosphere_migrator") {
    throw new Error(`migration URL authenticated as ${migrationIdentity.role_name}`);
  }

  console.log("[keyword-only-database] Runtime is extension-less and DDL-separated.");
}

main().catch((error) => {
  console.error(`[keyword-only-database] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
