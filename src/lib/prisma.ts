import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { articleSanitizerExtension } from "@/lib/prisma-extensions/article-sanitizer";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  pool: Pool | undefined;
};

/**
 * Parse a positive integer from an environment variable, falling back to a default.
 * Handles empty strings, non-numeric values, and NaN gracefully.
 */
function parsePositiveInt(envVar: string | undefined, defaultValue: number): number {
  const parsed = parseInt(envVar || "", 10);
  return isNaN(parsed) || parsed <= 0 ? defaultValue : parsed;
}

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  const pool = globalForPrisma.pool ?? new Pool({
    connectionString,
    max: parsePositiveInt(process.env.PG_POOL_MAX, 20),
    idleTimeoutMillis: parsePositiveInt(process.env.PG_IDLE_TIMEOUT_MS, 30000),
    connectionTimeoutMillis: parsePositiveInt(process.env.PG_CONN_TIMEOUT_MS, 5000),
  });
  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.pool = pool;
  }

  const adapter = new PrismaPg(pool);

  const client = new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

  // Apply the persistence-layer sanitizer as a hard boundary.
  // The extension intercepts article.create/update/upsert at the query layer,
  // stripping injected-memory blocks before they reach PostgreSQL.
  // Cast back to PrismaClient because the extension only adds query interceptors
  // (no new API surface), so the runtime behaviour is fully compatible.
  // See: https://github.com/SweetSophia/noosphere/issues/213
  return client.$extends(articleSanitizerExtension) as unknown as PrismaClient;
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
