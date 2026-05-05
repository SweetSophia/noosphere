import { spawnSync } from "node:child_process";
import process from "node:process";
import pg from "pg";

const { Pool } = pg;

const INITIAL_MIGRATION = "20260505150000_initial";
const REQUIRED_NOOSPHERE_TABLES = ["Topic", "Article", "User", "ApiKey", "RecallSettings"];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * Validates that an identifier is safe for use in SQL queries.
 * PostgreSQL identifier rules: starts with letter or underscore,
 * contains only letters, digits, underscores, and optionally quotes for special chars.
 */
function isValidIdentifier(name) {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

function runPrisma(args) {
  const result = spawnSync("node", ["node_modules/prisma/build/index.js", ...args], {
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Prisma command failed: prisma ${args.join(" ")}`);
  }
}

async function hasRegclass(client, regclassName) {
  // Validate identifier to prevent SQL injection even though we control the input
  if (!isValidIdentifier(regclassName)) {
    throw new Error(`Invalid identifier: ${regclassName}`);
  }
  const result = await client.query("SELECT to_regclass($1) AS name", [regclassName]);
  return Boolean(result.rows[0]?.name);
}

async function getPublicTableCount(client) {
  const result = await client.query(`
    SELECT COUNT(*)::int AS count
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename <> '_prisma_migrations'
  `);
  return Number(result.rows[0]?.count ?? 0);
}

async function getExistingRequiredTables(client) {
  const existing = [];
  for (const table of REQUIRED_NOOSPHERE_TABLES) {
    // Validate table name is a safe identifier
    if (!isValidIdentifier(table)) {
      throw new Error(`Invalid table name in REQUIRED_NOOSPHERE_TABLES: ${table}`);
    }
    if (await hasRegclass(client, `public."${table}"`)) {
      existing.push(table);
    }
  }
  return existing;
}

async function main() {
  const databaseUrl = requireEnv("DATABASE_URL");
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    const hasMigrationHistory = await hasRegclass(client, "public._prisma_migrations");
    const tableCount = await getPublicTableCount(client);

    if (!hasMigrationHistory && tableCount > 0) {
      const existingRequiredTables = await getExistingRequiredTables(client);
      const missingRequiredTables = REQUIRED_NOOSPHERE_TABLES.filter(
        (table) => !existingRequiredTables.includes(table),
      );

      if (missingRequiredTables.length > 0) {
        throw new Error(
          `Database is non-empty but does not look like an existing Noosphere schema. `
          + `Missing required tables: ${missingRequiredTables.join(", ")}. `
          + "Refusing to baseline automatically.",
        );
      }

      console.log(
        `Existing Noosphere schema detected without Prisma migration history; `
        + `marking ${INITIAL_MIGRATION} as already applied.`,
      );
      runPrisma(["migrate", "resolve", "--applied", INITIAL_MIGRATION, "--schema", "prisma/schema.prisma"]);
    }
  } finally {
    client.release();
    await pool.end();
  }

  runPrisma(["migrate", "deploy", "--schema", "prisma/schema.prisma"]);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
