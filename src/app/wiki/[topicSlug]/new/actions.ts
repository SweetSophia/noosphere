"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

export async function createArticle(
  topicSlug: string,
  formData: FormData
): Promise<void> {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    throw new Error("You must be signed in to create articles.");
  }

  const title = formData.get("title") as string;
  const content = formData.get("content") as string;
  const excerpt = formData.get("excerpt") as string;

  if (!title?.trim()) {
    throw new Error("Title is required.");
  }
  if (!content?.trim()) {
    throw new Error("Content cannot be empty.");
  }

  const topic = await prisma.topic.findUnique({ where: { slug: topicSlug } });
  if (!topic) throw new Error("Topic not found.");

  let slug = slugify(title);
  const existing = await prisma.article.findFirst({
    where: { topicId: topic.id, slug, deletedAt: null },
  });
  if (existing) {
    slug = `${slug}-${Date.now()}`;
  }

  const article = await prisma.article.create({
    data: {
      title: title.trim(),
      slug,
      content: content.trim(),
      excerpt: excerpt?.trim() || null,
      topicId: topic.id,
      authorId: session.user.id,
    },
  });

  revalidatePath(`/wiki/${topicSlug}`);
  revalidatePath(`/wiki/${topicSlug}/${article.slug}`);
  redirect(`/wiki/${topicSlug}/${article.slug}`);
}
