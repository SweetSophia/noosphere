"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session?.user || session.user.role !== "ADMIN") {
    throw new Error("Admin access required.");
  }
  return session;
}

export async function createScopeAction(formData: FormData) {
  await requireAdmin();

  const tag = String(formData.get("tag") ?? "").trim().toLowerCase();
  const description = String(formData.get("description") ?? "").trim();

  if (!tag) {
    throw new Error("Scope tag is required.");
  }

  if (!/^[a-z0-9-]+$/.test(tag)) {
    throw new Error("Tag must be lowercase alphanumeric with hyphens only (e.g. 'company-x').");
  }

  if (tag.length > 64) {
    throw new Error("Tag must be 64 characters or less.");
  }

  const existing = await prisma.restrictedScope.findUnique({ where: { tag } });
  if (existing) {
    throw new Error(`Scope '${tag}' already exists.`);
  }

  await prisma.restrictedScope.create({
    data: {
      tag,
      description: description || null,
      isSystem: false,
    },
  });

  revalidatePath("/wiki/admin/scopes");
  redirect("/wiki/admin/scopes");
}

export async function deleteScopeAction(formData: FormData) {
  await requireAdmin();

  const tag = String(formData.get("tag") ?? "").trim();
  if (!tag) {
    throw new Error("Scope tag is required.");
  }

  const scope = await prisma.restrictedScope.findUnique({ where: { tag } });
  if (!scope) {
    throw new Error(`Scope '${tag}' not found.`);
  }

  if (scope.isSystem) {
    throw new Error(`System scope '${tag}' cannot be deleted.`);
  }

  // Check if any articles use this scope
  const articleCount = await prisma.article.count({
    where: { restrictedTags: { has: tag } },
  });
  if (articleCount > 0) {
    throw new Error(
      `Cannot delete scope '${tag}' — ${articleCount} article(s) still use it. Remove the scope from those articles first.`
    );
  }

  await prisma.restrictedScope.delete({ where: { tag } });
  revalidatePath("/wiki/admin/scopes");
  redirect("/wiki/admin/scopes");
}
