import { createRequire } from "node:module";
import { defineConfig } from "prisma/config";

// dotenv is a development-only convenience. Docker/production injects env vars
// directly, so tolerate it being absent from production node_modules.
const require = createRequire(import.meta.url);
try {
  require("dotenv/config");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") {
    throw error;
  }
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
