/**
 * Seed initial topics
 * Usage: npx tsx scripts/seed-topics.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const TOPICS = [
  {
    name: "Engineering",
    slug: "engineering",
    description: "Technical documentation, architecture, and engineering practices",
    children: [
      {
        name: "Architecture",
        slug: "architecture",
        description: "System design and architectural decisions",
      },
      {
        name: "Backend",
        slug: "backend",
        description: "Server-side services and APIs",
      },
      {
        name: "Frontend",
        slug: "frontend",
        description: "UI/UX development and component libraries",
      },
      {
        name: "DevOps",
        slug: "devops",
        description: "Infrastructure, CI/CD, and deployment",
      },
      {
        name: "Security",
        slug: "security",
        description: "Security practices, audits, and hardening",
      },
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

async function seedTopics() {
  console.log("🌱 Seeding topics...\n");

  for (const topic of TOPICS) {
    const parent = await prisma.topic.upsert({
      where: { slug: topic.slug },
      update: { name: topic.name, description: topic.description ?? null },
      create: {
        name: topic.name,
        slug: topic.slug,
        description: topic.description ?? null,
      },
    });
    console.log(`  ✅ ${topic.name} (${parent.id})`);

    if (topic.children) {
      for (const child of topic.children) {
        const sub = await prisma.topic.upsert({
          where: { slug: child.slug },
          update: { name: child.name, description: child.description ?? null, parentId: parent.id },
          create: {
            name: child.name,
            slug: child.slug,
            description: child.description ?? null,
            parentId: parent.id,
          },
        });
        console.log(`     ✅ ${child.name}`);
      }
    }
  }

  console.log("\n✨ Done!");
}

seedTopics()
  .catch((e) => {
    console.error("Error:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
