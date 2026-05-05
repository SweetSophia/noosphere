import crypto from "node:crypto";
import process from "node:process";
import bcrypt from "bcryptjs";
import pg from "pg";

const { Pool } = pg;

const TOPICS = [
  {
    name: "Engineering",
    slug: "engineering",
    description: "Technical documentation, architecture, and engineering practices",
    children: [
      { name: "Architecture", slug: "architecture", description: "System design and architectural decisions" },
      { name: "Backend", slug: "backend", description: "Server-side services and APIs" },
      { name: "Frontend", slug: "frontend", description: "UI/UX development and component libraries" },
      { name: "DevOps", slug: "devops", description: "Infrastructure, CI/CD, and deployment" },
      { name: "Security", slug: "security", description: "Security practices, audits, and hardening" },
    ],
  },
  {
    name: "Projects",
    slug: "projects",
    description: "Project-specific documentation",
    children: [
      { name: "Noosphere", slug: "noosphere", description: "This wiki system" },
      { name: "PK-PRO", slug: "pk-pro", description: "Product knowledge database" },
      { name: "IHK Study Trainer", slug: "ihk-study-trainer", description: "Study and practice platform" },
    ],
  },
  {
    name: "Research",
    slug: "research",
    description: "Research notes, experiments, and findings",
    children: [
      { name: "AI & LLMs", slug: "ai-llms", description: "LLM evaluations, prompts, and integrations" },
      { name: "Tools", slug: "tools", description: "Tool evaluations and comparisons" },
    ],
  },
  {
    name: "Workflows",
    slug: "workflows",
    description: "Operational runbooks and procedures",
    children: [
      { name: "Deployment", slug: "deployment", description: "Deployment procedures" },
      { name: "Incident Response", slug: "incident-response", description: "How to handle incidents" },
      { name: "Onboarding", slug: "onboarding", description: "New member onboarding guides" },
    ],
  },
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function hashApiKey(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function generateApiKey() {
  return `noo_${crypto.randomBytes(32).toString("base64url")}`;
}

function id() {
  return crypto.randomUUID();
}

async function upsertTopic(client, topic, parentId = null) {
  const updateResult = await client.query(
    `UPDATE "Topic"
     SET name = $2,
         description = $3,
         "parentId" = $4,
         "updatedAt" = NOW()
     WHERE slug = $1
     RETURNING id`,
    [topic.slug, topic.name, topic.description ?? null, parentId],
  );

  if (updateResult.rows[0]?.id) return updateResult.rows[0].id;

  const result = await client.query(
    `INSERT INTO "Topic" (id, name, slug, description, "parentId", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       "parentId" = EXCLUDED."parentId",
       "updatedAt" = NOW()
     RETURNING id`,
    [id(), topic.name, topic.slug, topic.description ?? null, parentId],
  );
  return result.rows[0].id;
}

async function main() {
  const databaseUrl = requireEnv("DATABASE_URL");
  const adminEmail = process.env.NOOSPHERE_ADMIN_EMAIL || "admin@noosphere.local";
  const adminPassword = process.env.NOOSPHERE_ADMIN_PASSWORD || crypto.randomBytes(24).toString("base64url");
  const adminName = process.env.NOOSPHERE_ADMIN_NAME || "Noosphere Admin";
  const rawApiKey = process.env.NOOSPHERE_BOOTSTRAP_API_KEY || generateApiKey();
  const apiKeyName = process.env.NOOSPHERE_API_KEY_NAME || "OpenClaw Noosphere Memory";
  const permissions = process.env.NOOSPHERE_API_KEY_PERMISSIONS || "ADMIN";

  if (!["READ", "WRITE", "ADMIN"].includes(permissions)) {
    throw new Error("NOOSPHERE_API_KEY_PERMISSIONS must be READ, WRITE, or ADMIN");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const passwordHash = await bcrypt.hash(adminPassword, 12);
    await client.query(
      `INSERT INTO "User" (id, email, name, "passwordHash", role, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, 'ADMIN', NOW(), NOW())
       ON CONFLICT (email) DO UPDATE SET
         name = EXCLUDED.name,
         "passwordHash" = EXCLUDED."passwordHash",
         role = 'ADMIN',
         "updatedAt" = NOW()`,
      [id(), adminEmail, adminName, passwordHash],
    );

    for (const topic of TOPICS) {
      const parentId = await upsertTopic(client, topic, null);
      for (const child of topic.children ?? []) {
        await upsertTopic(client, child, parentId);
      }
    }

    const keyHash = hashApiKey(rawApiKey);
    const keyPrefix = rawApiKey.slice(0, 8);
    await client.query(
      `INSERT INTO "ApiKey" (id, name, "keyHash", "keyPrefix", permissions, "createdAt")
       VALUES ($1, $2, $3, $4, $5::"Permissions", NOW())
       ON CONFLICT ("keyHash") DO UPDATE SET
         name = EXCLUDED.name,
         permissions = EXCLUDED.permissions,
         "revokedAt" = NULL`,
      [id(), apiKeyName, keyHash, keyPrefix, permissions],
    );

    await client.query("COMMIT");

    console.log(JSON.stringify({
      ok: true,
      adminEmail,
      adminPassword,
      apiKey: rawApiKey,
      apiKeyPrefix: keyPrefix,
      permissions,
    }));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
