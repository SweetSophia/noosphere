/**
 * Create an API key for agent authentication
 * Usage: npx tsx scripts/create-api-key.ts <name> [permissions]
 * permissions: READ | WRITE | ADMIN (default: WRITE)
 */

import { PrismaClient } from "@prisma/client";
import { generateApiKey } from "../src/lib/api/keys";

const prisma = new PrismaClient();

async function main() {
  const name = process.argv[2];
  let permissions = (process.argv[3] || "WRITE") as "READ" | "WRITE" | "ADMIN";

  if (!name) {
    console.error("Usage: npx tsx scripts/create-api-key.ts <name> [READ|WRITE|ADMIN]");
    process.exit(1);
  }

  if (!["READ", "WRITE", "ADMIN"].includes(permissions)) {
    console.error("Permissions must be one of: READ, WRITE, ADMIN");
    process.exit(1);
  }

  const { raw, hash, prefix } = generateApiKey(name);

  const apiKey = await prisma.apiKey.create({
    data: { name, keyHash: hash, keyPrefix: prefix, permissions },
  });

  console.log(`\n✅ API key created for: ${name}`);
  console.log(`\n📋 Key ID: ${apiKey.id}`);
  console.log(`🔑 Permissions: ${apiKey.permissions}`);
  console.log(`🔐 Prefix: ${prefix}...`);
  console.log(`\n⚠️  SAVE THIS NOW — the raw key cannot be retrieved later:`);
  console.log(`   ${raw}\n`);
}

main()
  .catch((e) => {
    console.error("Error:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
