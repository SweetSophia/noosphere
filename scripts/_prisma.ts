import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

/**
 * Parse a positive integer from an environment variable, falling back to a default.
 * Handles empty strings, non-numeric values, and NaN gracefully.
 */
function parsePositiveInt(envVar: string | undefined, defaultValue: number): number {
  const parsed = parseInt(envVar || "", 10);
  return isNaN(parsed) || parsed <= 0 ? defaultValue : parsed;
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL must be set before running scripts.");
}

const pool = new Pool({
  connectionString,
  max: parsePositiveInt(process.env.PG_POOL_MAX, 20),
  idleTimeoutMillis: parsePositiveInt(process.env.PG_IDLE_TIMEOUT_MS, 30000),
  connectionTimeoutMillis: parsePositiveInt(process.env.PG_CONN_TIMEOUT_MS, 5000),
});
const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({ adapter });

export async function closePrisma() {
  await prisma.$disconnect();
  await pool.end();
}
