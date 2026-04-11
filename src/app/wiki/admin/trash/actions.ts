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

export async function restoreArticleAction(formData: FormData) {
  await requireAdmin();

  const articleId = String(formData.get("articleId") ?? "").trim();
  if (!articleId) {
    throw new Error("Article ID missing.");
  }

  const article = await prisma.article.update({
    where: { id: articleId },
    data: { deletedAt: null, updatedAt: new Date() },
    include: { topic: true },
  });

  revalidatePath("/wiki");
  revalidatePath(`/wiki/${article.topic.slug}`);
  revalidatePath(`/wiki/${article.topic.slug}/${article.slug}`);
  revalidatePath("/wiki/search");
  revalidatePath("/wiki/admin/trash");
  redirect("/wiki/admin/trash");
}
