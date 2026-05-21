"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/wiki";
import { invalidateSearchCache } from "@/lib/cache/search-cache";

async function requireEditor() {
  const session = await getServerSession(authOptions);
  if (!session?.user) throw new Error("You must be signed in.");
  if (session.user.role !== "EDITOR" && session.user.role !== "ADMIN") {
    throw new Error("Editor or admin role required.");
  }
  return session;
}

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session?.user) throw new Error("You must be signed in.");
  if (session.user.role !== "ADMIN") throw new Error("Admin role required.");
  return session;
}

// ── Create topic ─────────────────────────────────────────────────────────────

export async function createTopicAction(formData: FormData) {
  await requireEditor();

  const name = String(formData.get("name") ?? "").trim();
  const slugInput = String(formData.get("slug") ?? "").trim();
  const parentId = formData.get("parentId");
  const description = String(formData.get("description") ?? "").trim();

  if (!name) throw new Error("Topic name is required.");

  const parentIdValue = parentId && typeof parentId === "string" && parentId !== "" ? String(parentId) : null;

  // Validate parent exists if provided
  if (parentIdValue) {
    const parent = await prisma.topic.findUnique({ where: { id: parentIdValue } });
    if (!parent) throw new Error("Parent topic not found.");
  }

  const finalSlug = slugInput ? slugify(slugInput) : slugify(name);
  if (!finalSlug) throw new Error("Could not derive a valid slug.");

  // Ensure slug is unique
  let finalFinalSlug = finalSlug;
  let counter = 1;
  while (await prisma.topic.findUnique({ where: { slug: finalFinalSlug } })) {
    finalFinalSlug = `${finalSlug}-${counter}`;
    counter++;
  }

  await prisma.topic.create({
    data: {
      name,
      slug: finalFinalSlug,
      parentId: parentIdValue,
      description: description || null,
    },
  });

  await invalidateSearchCache();

  revalidatePath("/wiki");
  revalidatePath("/wiki/admin/topics");
  redirect("/wiki/admin/topics?flash=Topic+created");
}

// ── Update topic ─────────────────────────────────────────────────────────────

export async function updateTopicAction(formData: FormData) {
  await requireEditor();

  const id = String(formData.get("id") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const slugInput = String(formData.get("slug") ?? "").trim();
  const parentId = formData.get("parentId");
  const description = String(formData.get("description") ?? "").trim();

  if (!id) throw new Error("Topic ID is required.");
  if (!name) throw new Error("Topic name is required.");

  const existing = await prisma.topic.findUnique({ where: { id } });
  if (!existing) throw new Error("Topic not found.");

  const parentIdValue = parentId && typeof parentId === "string" && parentId !== "" ? String(parentId) : null;

  // Validate parent
  if (parentIdValue === id) throw new Error("A topic cannot be its own parent.");
  if (parentIdValue) {
    const parent = await prisma.topic.findUnique({ where: { id: parentIdValue } });
    if (!parent) throw new Error("Parent topic not found.");
    // Cycle check
    const descendants: string[] = [];
    const getDescendants = async (topicId: string): Promise<string[]> => {
      const children = await prisma.topic.findMany({ where: { parentId: topicId }, select: { id: true } });
      const desc: string[] = [];
      for (const c of children) {
        desc.push(c.id);
        desc.push(...await getDescendants(c.id));
      }
      return desc;
    };
    const desc = await getDescendants(id);
    if (desc.includes(parentIdValue)) throw new Error("Cannot set a descendant as the parent (cycle).");
  }

  const finalSlug = slugInput ? slugify(slugInput) : existing.slug;
  if (finalSlug !== existing.slug) {
    const conflict = await prisma.topic.findUnique({ where: { slug: finalSlug } });
    if (conflict) throw new Error("Slug already in use.");
  }

  await prisma.topic.update({
    where: { id },
    data: {
      name,
      slug: finalSlug,
      parentId: parentIdValue,
      description: description || null,
    },
  });

  await invalidateSearchCache();

  revalidatePath("/wiki");
  revalidatePath("/wiki/admin/topics");
}

// ── Delete topic ─────────────────────────────────────────────────────────────

export async function deleteTopicAction(formData: FormData) {
  await requireAdmin();

  const id = String(formData.get("id") ?? "").trim();
  if (!id) throw new Error("Topic ID is required.");

  const existing = await prisma.topic.findUnique({ where: { id } });
  if (!existing) throw new Error("Topic not found.");

  const articleCount = await prisma.article.count({ where: { topicId: id } });
  if (articleCount > 0) throw new Error(`Topic has ${articleCount} article(s). Move or delete them first.`);

  const childCount = await prisma.topic.count({ where: { parentId: id } });
  if (childCount > 0) throw new Error(`Topic has ${childCount} subtopic(s). Delete or reassign them first.`);

  await prisma.topic.delete({ where: { id } });

  await invalidateSearchCache();

  revalidatePath("/wiki");
  revalidatePath("/wiki/admin/topics");
}
