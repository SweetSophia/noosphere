import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiKey } from "@/lib/api/keys";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import JSZip from "jszip";
import yaml from "js-yaml";

// Disable Next.js body parsing for file uploads
export const dynamic = "force-dynamic";

interface ImportArticle {
  filename: string;
  title: string;
  topicSlug: string;
  content: string;
  slug: string;
  tags: string[];
  excerpt?: string;
  confidence?: string;
  status?: string;
  sourceUrl?: string;
  sourceType?: string;
  error?: string;
}

// GET /api/import — Return import format documentation
export async function GET() {
  return NextResponse.json({
    endpoint: "POST /api/import",
    description: "Import articles from a markdown zip export",
    contentType: "multipart/form-data",
    auth: "API key (WRITE/ADMIN) or session (EDITOR/ADMIN)",
    body: {
      file: "zip archive of .md files with YAML frontmatter (required)",
      defaultTopicSlug: "fallback topic slug if file has no topic (optional)",
      overwrite: "if true, update existing articles with same slug+topic (default: false)",
    },
    frontmatterFields: {
      required: ["title", "topic", "content"],
      optional: ["tags", "excerpt", "confidence", "status", "sourceUrl", "sourceType", "lastReviewed"],
    },
    exampleFrontmatter: `---
title: My Article Title
topic: engineering
tags: [python, backend]
createdAt: 2024-01-01T00:00:00Z
confidence: high
status: published
---`,
    response: {
      success: true,
      imported: 5,
      skipped: 2,
      errors: [{ filename: "bad-article.md", error: "Missing required field: title" }],
    },
  });
}

// POST /api/import — Import articles from a markdown zip
export async function POST(request: NextRequest) {
  const apiAuth = await requireApiKey(request);
  const session = await getServerSession(authOptions);

  if (!apiAuth.authorized && !session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (apiAuth.authorized) {
    if (apiAuth.permissions !== "WRITE" && apiAuth.permissions !== "ADMIN") {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }
  } else {
    const role = (session?.user as { role?: string }).role;
    if (role !== "EDITOR" && role !== "ADMIN") {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }
  }

  // Parse multipart form using Web API
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Failed to parse form data" }, { status: 400 });
  }

  const fileEntry = formData.get("file");
  if (!fileEntry || typeof fileEntry === "string") {
    return NextResponse.json({ error: "No zip file provided" }, { status: 400 });
  }

  const overwrite = formData.get("overwrite") === "true";
  const defaultTopicSlug = typeof formData.get("defaultTopicSlug") === "string"
    ? (formData.get("defaultTopicSlug") as string)
    : undefined;

  // Read zip file
  let zipBuffer: ArrayBuffer;
  try {
    zipBuffer = await fileEntry.arrayBuffer();
  } catch {
    return NextResponse.json({ error: "Failed to read uploaded zip file" }, { status: 400 });
  }

  // Parse zip
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBuffer);
  } catch {
    return NextResponse.json({ error: "Invalid or corrupted zip file" }, { status: 400 });
  }

  // Fetch all topics for slug lookup
  const allTopics = await prisma.topic.findMany();
  const topicBySlug = new Map(allTopics.map((t) => [t.slug, t]));

  // Fetch all tags for name lookup
  const allTags = await prisma.tag.findMany();
  const tagBySlug = new Map(allTags.map((t) => [t.slug, t]));

  // Parse each .md file
  const toImport: ImportArticle[] = [];
  const zipFiles = Object.values(zip.files);

  for (const entry of zipFiles) {
    if (entry.dir || !entry.name.endsWith(".md") || entry.name.includes("README")) continue;

    let content: string;
    try {
      content = await entry.async("string");
    } catch {
      toImport.push({ filename: entry.name, title: "", slug: "", topicSlug: "", content: "", tags: [], error: "Failed to read file" });
      continue;
    }

    // Parse frontmatter (handles both \n and \r\n)
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!fmMatch) {
      toImport.push({ filename: entry.name, title: "", slug: "", topicSlug: "", content: "", tags: [], error: "No YAML frontmatter found" });
      continue;
    }

    let frontmatter: Record<string, unknown>;
    try {
      frontmatter = yaml.load(fmMatch[1]) as Record<string, unknown>;
    } catch {
      toImport.push({ filename: entry.name, title: "", slug: "", topicSlug: "", content: "", tags: [], error: "Invalid YAML frontmatter" });
      continue;
    }

    const title = typeof frontmatter.title === "string" ? frontmatter.title.trim() : "";
    const topicSlug = (typeof frontmatter.topic === "string" ? frontmatter.topic : defaultTopicSlug ?? "") as string;
    const articleContent = fmMatch[2];

    if (!title || !articleContent.trim()) {
      toImport.push({ filename: entry.name, title, slug: "", topicSlug, content: articleContent, tags: [], error: "Missing required field: title or content" });
      continue;
    }

    if (!topicSlug) {
      toImport.push({ filename: entry.name, title, slug: "", topicSlug: "", content: articleContent, tags: [], error: "Missing required field: topic" });
      continue;
    }

    // Derive slug from filename (strip path and .md)
    const slug = entry.name
      .replace(/\.md$/i, "")
      .replace(/.*\//, "")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80);

    if (!slug) {
      toImport.push({ filename: entry.name, title, slug: "", topicSlug, content: articleContent, tags: [], error: "Could not derive valid slug from filename" });
      continue;
    }

    const tags = Array.isArray(frontmatter.tags) ? (frontmatter.tags as string[]).map(String) : [];

    toImport.push({
      filename: entry.name,
      title,
      topicSlug,
      slug,
      content: articleContent,
      tags,
      excerpt: typeof frontmatter.excerpt === "string" ? frontmatter.excerpt : undefined,
      confidence: typeof frontmatter.confidence === "string" ? frontmatter.confidence : undefined,
      status: typeof frontmatter.status === "string" ? frontmatter.status : undefined,
      sourceUrl: typeof frontmatter.sourceUrl === "string" ? frontmatter.sourceUrl : undefined,
      sourceType: typeof frontmatter.sourceType === "string" ? frontmatter.sourceType : undefined,
    });
  }

  // Validate topics exist
  for (const article of toImport) {
    if (!article.error && !topicBySlug.has(article.topicSlug)) {
      article.error = `Topic "${article.topicSlug}" not found`;
    }
  }

  // Process imports
  const sessionUser = session?.user as ({ id?: string } | null) | undefined;
  const userId = sessionUser?.id ?? null;
  const userName = session?.user?.name ?? "Importer";

  const results = { imported: 0, skipped: 0, errors: 0 };

  await prisma.$transaction(async (tx) => {
    for (const article of toImport) {
      if (article.error) {
        results.errors++;
        continue;
      }

      const topic = topicBySlug.get(article.topicSlug)!;

      // Check slug uniqueness
      const existing = await tx.article.findUnique({
        where: { topicId_slug: { topicId: topic.id, slug: article.slug } },
      });

      if (existing) {
        if (overwrite && !existing.deletedAt) {
          // Update existing article
          await tx.article.update({
            where: { id: existing.id },
            data: {
              title: article.title,
              content: article.content,
              excerpt: article.excerpt ?? article.content.slice(0, 160).replace(/[#*`_]/g, ""),
              confidence: article.confidence ?? null,
              status: article.status ?? existing.status,
              updatedAt: new Date(),
            },
          });
          results.imported++;
        } else {
          results.skipped++;
        }
        continue;
      }

      // Upsert tags
      const tagConnections = await Promise.all(
        article.tags.map(async (tagName) => {
          const tagSlug = tagName.toLowerCase().replace(/\s+/g, "-");
          let tag = tagBySlug.get(tagSlug);
          if (!tag) {
            tag = await tx.tag.upsert({
              where: { slug: tagSlug },
              create: { name: tagName, slug: tagSlug },
              update: {},
            });
            tagBySlug.set(tagSlug, tag);
          }
          return { tagId: tag.id };
        })
      );

      await tx.article.create({
        data: {
          title: article.title,
          slug: article.slug,
          content: article.content,
          excerpt: article.excerpt ?? article.content.slice(0, 160).replace(/[#*`_]/g, ""),
          topicId: topic.id,
          authorId: userId,
          authorName: userName,
          confidence: article.confidence ?? null,
          status: article.status ?? "published",
          sourceUrl: article.sourceUrl ?? null,
          sourceType: article.sourceType ?? "import",
          tags: { create: tagConnections },
          revisions: {
            create: {
              authorId: userId,
              title: article.title,
              content: article.content,
            },
          },
        },
      });

      results.imported++;
    }
  });

  return NextResponse.json({
    success: true,
    summary: results,
    articles: toImport.map((a) => ({
      filename: a.filename,
      title: a.title,
      slug: a.slug,
      topic: a.topicSlug,
      imported: !a.error,
      error: a.error,
    })),
  });
}
