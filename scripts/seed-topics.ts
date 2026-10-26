/**
 * Seed initial topics
 * Usage: npx tsx scripts/seed-topics.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { closePrisma, prisma } from "./_prisma";
import { updateTopicSafely } from "../src/lib/taxonomy";

interface BootstrapTopic {
  name: string;
  slug: string;
  description?: string | null;
  children?: BootstrapTopic[];
}

const TOPICS = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../docker/bootstrap-topics.json", import.meta.url)),
    "utf8",
  ),
) as BootstrapTopic[];

async function seedTopics() {
  console.log("Seeding topics...\n");

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
    console.log("  + " + topic.name);

    if (topic.children) {
      for (const child of topic.children) {
        const existing = await prisma.topic.findUnique({ where: { slug: child.slug } });
        if (existing) {
          await updateTopicSafely(existing.id, {
            name: child.name, description: child.description ?? null, parentId: parent.id,
          }, prisma);
        } else await prisma.topic.create({
          data: {
            name: child.name,
            slug: child.slug,
            description: child.description ?? null,
            parentId: parent.id,
          },
        });
        console.log("     + " + child.name);
      }
    }
  }

  console.log("\nDone!");
}

seedTopics()
  .catch((e) => {
    console.error("Error:", e);
    process.exit(1);
  })
  .finally(() => closePrisma());
