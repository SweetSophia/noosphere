"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildTagConnections, parseTagInput } from "@/lib/wiki";

export async function saveArticle(
  topicSlug: string,
  articleSlug: string,
  formData: FormData
): Promise<void> {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    throw new Error("You must be signed in to edit articles.");
  }

  const content = String(formData.get("content") ?? "");
  const title = String(formData.get("title") ?? "");
  const excerpt = String(formData.get("excerpt") ?? "");
  const tags = parseTagInput(String(formData.get("tags") ?? ""));

  if (!content.trim()) {
    throw new Error("Content cannot be empty.");
  }

  const topic = await prisma.topic.findUnique({ where: { slug: topicSlug } });
  if (!topic) throw new Error("Topic not found.");

  const article = await prisma.article.findFirst({
    where: { topicId: topic.id, slug: articleSlug, deletedAt: null },
  });

  if (!article) throw new Error("Article not found.");

  const nextTitle = title.trim() || article.title;
  const nextContent = content.trim();
  const nextExcerpt = excerpt.trim() || nextContent.slice(0, 160).replace(/[#*`_]/g, "");
  const tagConnections = await buildTagConnections(tags);

  await prisma.$transaction([
    prisma.article.update({
      where: { id: article.id },
      data: {
        content: nextContent,
        title: nextTitle,
        excerpt: nextExcerpt,
        updatedAt: new Date(),
      },
    }),
    prisma.articleTag.deleteMany({ where: { articleId: article.id } }),
    prisma.articleRevision.create({
      data: {
        articleId: article.id,
        authorId: session.user.id,
        content: nextContent,
        title: nextTitle,
      },
    }),
  ]);

  if (tagConnections.length > 0) {
    await prisma.articleTag.createMany({
      data: tagConnections.map((connection) => ({
        articleId: article.id,
        tagId: connection.tagId,
      })),
      skipDuplicates: true,
    });
  }

  revalidatePath(`/wiki/${topicSlug}`);
  revalidatePath(`/wiki/${topicSlug}/${articleSlug}`);
  revalidatePath("/wiki");
  revalidatePath("/wiki/search");
  redirect(`/wiki/${topicSlug}/${articleSlug}`);
}
