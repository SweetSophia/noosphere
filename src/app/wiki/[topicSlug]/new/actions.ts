"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildTagConnections, parseTagInput, slugify } from "@/lib/wiki";

async function requireEditorSession() {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    throw new Error("You must be signed in to create articles.");
  }

  if (session.user.role !== "EDITOR" && session.user.role !== "ADMIN") {
    throw new Error("You do not have permission to create articles.");
  }

  return session;
}

export async function createArticle(
  topicSlug: string,
  formData: FormData
): Promise<void> {
  const session = await requireEditorSession();

  const title = String(formData.get("title") ?? "");
  const content = String(formData.get("content") ?? "");
  const excerpt = String(formData.get("excerpt") ?? "");
  const tags = parseTagInput(String(formData.get("tags") ?? ""));

  if (!title.trim()) {
    throw new Error("Title is required.");
  }
  if (!content.trim()) {
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

  const tagConnections = await buildTagConnections(tags);

  const article = await prisma.article.create({
    data: {
      title: title.trim(),
      slug,
      content: content.trim(),
      excerpt: excerpt.trim() || content.trim().slice(0, 160).replace(/[#*`_]/g, ""),
      topicId: topic.id,
      authorId: session.user.id,
      tags: { create: tagConnections },
      revisions: {
        create: {
          authorId: session.user.id,
          title: title.trim(),
          content: content.trim(),
        },
      },
    },
  });

  revalidatePath(`/wiki/${topicSlug}`);
  revalidatePath(`/wiki/${topicSlug}/${article.slug}`);
  revalidatePath("/wiki");
  revalidatePath("/wiki/search");
  redirect(`/wiki/${topicSlug}/${article.slug}`);
}
