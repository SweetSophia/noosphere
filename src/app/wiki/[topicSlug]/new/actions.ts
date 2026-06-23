"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildTagConnections, parseTagInput, slugify } from "@/lib/wiki";
import { invalidateSearchCache } from "@/lib/cache/search-cache";
import {
  buildArticleStripObservation,
  sanitizeArticleContent,
  sanitizeArticleExcerpt,
} from "@/lib/api/article-content";
import { detectSecretInInputs } from "@/lib/memory/api/save";

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
  const normalizedTitle = title.trim();

  if (!normalizedTitle) {
    throw new Error("Title is required.");
  }
  if (!content.trim()) {
    throw new Error("Content cannot be empty.");
  }

  const contentSanitization = sanitizeArticleContent(content.trim());
  if (!contentSanitization.ok) {
    throw new Error(contentSanitization.error);
  }
  const sanitizedContent = contentSanitization.content.trim();
  const rawExcerpt = excerpt.trim();
  const excerptSanitization = rawExcerpt
    ? sanitizeArticleExcerpt(rawExcerpt)
    : undefined;
  if (excerptSanitization && !excerptSanitization.ok) {
    throw new Error(excerptSanitization.error);
  }
  const sanitizedExcerpt = excerptSanitization?.excerpt.trim();
  const stripObservation = buildArticleStripObservation([
    { field: "content", strippedBlocks: contentSanitization.strippedBlocks },
    {
      field: "excerpt",
      strippedBlocks: excerptSanitization?.strippedBlocks ?? [],
    },
  ]);
  const secretError = detectSecretInInputs([
    { field: "title", value: normalizedTitle },
    { field: "content", value: sanitizedContent },
    { field: "excerpt", value: sanitizedExcerpt },
    ...tags.map((value) => ({ field: "tags", value })),
  ]);
  if (secretError) {
    throw new Error(secretError.error);
  }

  const topic = await prisma.topic.findUnique({ where: { slug: topicSlug } });
  if (!topic) throw new Error("Topic not found.");

  let slug = slugify(normalizedTitle) || "untitled";
  const existing = await prisma.article.findFirst({
    where: { topicId: topic.id, slug, deletedAt: null },
  });
  if (existing) {
    slug = `${slug}-${Date.now()}`;
  }

  const tagConnections = await buildTagConnections(tags);

  // Collect restricted tags from form
  const restrictedTags: string[] = [];
  formData.forEach((value, key) => {
    if (key === "restrictedTags" && typeof value === "string" && value.trim()) {
      restrictedTags.push(value.trim());
    }
  });

  // Validate: only save scopes that exist in the RestrictedScope registry
  if (restrictedTags.length > 0) {
    const validScopes = await prisma.restrictedScope.findMany({
      where: { tag: { in: restrictedTags } },
      select: { tag: true },
    });
    const validSet = new Set(validScopes.map((s) => s.tag));
    const invalid = restrictedTags.filter((t) => !validSet.has(t));
    if (invalid.length > 0) {
      throw new Error(`Unknown scope(s): ${invalid.join(", ")}`);
    }
  }

  const article = await prisma.$transaction(async (tx) => {
    const created = await tx.article.create({
      data: {
        title: normalizedTitle,
        slug,
        content: sanitizedContent,
        excerpt: sanitizedExcerpt || sanitizedContent.slice(0, 160).replace(/[#*`_]/g, ""),
        topicId: topic.id,
        authorId: session.user.id,
        tags: { create: tagConnections },
        restrictedTags,
        revisions: {
          create: {
            authorId: session.user.id,
            title: normalizedTitle,
            content: sanitizedContent,
          },
        },
      },
    });

    if (stripObservation) {
      await tx.activityLog.create({
        data: {
          type: "article_content_stripped",
          title: `Injected memory stripped from wiki article create: ${normalizedTitle}`,
          authorName: session.user.name ?? session.user.email ?? "Web UI",
          details: {
            route: "wiki createArticle",
            kind: "single",
            articleId: created.id,
            topicId: topic.id,
            slug,
            ...stripObservation,
          },
        },
      });
    }

    return created;
  });

  await invalidateSearchCache();

  revalidatePath(`/wiki/${topicSlug}`);
  revalidatePath(`/wiki/${topicSlug}/${article.slug}`);
  revalidatePath("/wiki");
  revalidatePath("/wiki/search");
  redirect(`/wiki/${topicSlug}/${article.slug}`);
}
