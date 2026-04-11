"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function saveArticle(
  topicSlug: string,
  articleSlug: string,
  formData: FormData
): Promise<void> {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    throw new Error("You must be signed in to edit articles.");
  }

  const content = formData.get("content") as string;
  const title = formData.get("title") as string;

  if (!content?.trim()) {
    throw new Error("Content cannot be empty.");
  }

  const topic = await prisma.topic.findUnique({ where: { slug: topicSlug } });
  if (!topic) throw new Error("Topic not found.");

  const article = await prisma.article.findFirst({
    where: { topicId: topic.id, slug: articleSlug, deletedAt: null },
  });

  if (!article) throw new Error("Article not found.");

  await prisma.article.update({
    where: { id: article.id },
    data: {
      content: content.trim(),
      title: title.trim() || article.title,
      updatedAt: new Date(),
    },
  });

  await prisma.articleRevision.create({
    data: {
      articleId: article.id,
      authorId: session.user.id,
      content: content.trim(),
      title: title.trim() || article.title,
    },
  });

  revalidatePath(`/wiki/${topicSlug}/${articleSlug}`);
  redirect(`/wiki/${topicSlug}/${articleSlug}`);
}
