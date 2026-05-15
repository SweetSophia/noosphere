"use server";

import { revalidatePath } from "next/cache";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/wiki";

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

// ── Create tag ───────────────────────────────────────────────────────────────

export async function createTagAction(formData: FormData) {
  await requireEditor();

  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Tag name is required.");

  const tagSlug = slugify(name);
  if (!tagSlug) throw new Error("Could not derive a valid slug from name.");

  const existing = await prisma.tag.findFirst({
    where: { OR: [{ name }, { slug: tagSlug }] },
  });
  if (existing) throw new Error(`Tag "${name}" already exists.`);

  await prisma.tag.create({ data: { name, slug: tagSlug } });
  revalidatePath("/wiki");
  revalidatePath("/wiki/admin/tags");
}

// ── Rename tag ───────────────────────────────────────────────────────────────

export async function renameTagAction(formData: FormData) {
  await requireEditor();

  const id = String(formData.get("id") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  if (!id) throw new Error("Tag ID is required.");
  if (!name) throw new Error("Tag name is required.");

  const existing = await prisma.tag.findUnique({ where: { id } });
  if (!existing) throw new Error("Tag not found.");

  const newSlug = slugify(name);
  if (!newSlug) throw new Error("Could not derive a valid slug.");

  if (newSlug !== existing.slug) {
    const conflict = await prisma.tag.findUnique({ where: { slug: newSlug } });
    if (conflict) throw new Error(`Slug "${newSlug}" is already in use.`);
  }

  await prisma.tag.update({ where: { id }, data: { name, slug: newSlug } });
  revalidatePath("/wiki");
  revalidatePath("/wiki/admin/tags");
}

// ── Delete tag ────────────────────────────────────────────────────────────────

export async function deleteTagAction(formData: FormData) {
  await requireAdmin();

  const id = String(formData.get("id") ?? "").trim();
  if (!id) throw new Error("Tag ID is required.");

  const existing = await prisma.tag.findUnique({ where: { id } });
  if (!existing) throw new Error("Tag not found.");

  const articleCount = await prisma.articleTag.count({ where: { tagId: id } });
  if (articleCount > 0) {
    throw new Error(`Tag "${existing.name}" is used by ${articleCount} article(s). Remove it from articles first.`);
  }

  await prisma.tag.delete({ where: { id } });
  revalidatePath("/wiki");
  revalidatePath("/wiki/admin/tags");
}
