/**
 * Seed initial topics
 * Usage: npx tsx scripts/seed-topics.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { closePrisma, prisma } from "./_prisma";
import { isPrismaCode, TaxonomyConflict, updateTopicSafely } from "../src/lib/taxonomy";

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
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            // Preserve the atomic slug upsert for concurrent seed invocations.
            // Existing hierarchy is never rewritten here: new children start
            // detached and every move goes through serializable validation.
            const row = await prisma.topic.upsert({
              where: { slug: child.slug },
              update: { name: child.name, description: child.description ?? null },
              create: {
                name: child.name, slug: child.slug,
                description: child.description ?? null,
              },
            });
            await updateTopicSafely(row.id, { parentId: parent.id }, prisma);
            break;
          } catch (error) {
            const retryable = isPrismaCode(error, "P2002") || isPrismaCode(error, "P2025")
              || error instanceof TaxonomyConflict && [404, 409].includes(error.status);
            if (attempt < 2 && retryable) continue;
            throw error;
          }
        }
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
