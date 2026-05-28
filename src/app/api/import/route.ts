import { NextRequest, NextResponse } from "next/server";
import { Permissions } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission, canAccessScopes } from "@/lib/api/auth";
import JSZip from "jszip";
import { isValidConfidence, isValidStatus } from "@/lib/validation";
import { rateLimit } from "@/lib/rate-limit";
import { invalidateSearchCache } from "@/lib/cache/search-cache";
import {
  parseNoosphereMarkdown,
  readMarkdownString,
  readMarkdownStringArray,
} from "@/lib/markdown/noosphere-markdown";

// Disable Next.js body parsing for file uploads
export const dynamic = "force-dynamic";

// ── Validation helpers ───────────────────────────────────────────────────────

function validatedConfidence(v: string | undefined): string | null {
  return v && isValidConfidence(v) ? v : null;
}

function validatedStatus(v: string | undefined, fallback: string): string {
  return v && isValidStatus(v) ? v : fallback;
}

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
  restrictedTags?: string[];
  error?: string;
}

// GET /api/import — Return import format documentation
export async function GET(request: NextRequest) {
  const rl = await rateLimit(request, { windowMs: 60_000, maxRequests: 60, keyPrefix: "import-get" });
  if (!rl.allowed) return rl.response;

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
      optional: ["id", "slug", "topicPath", "tags", "excerpt", "confidence", "status", "sourceUrl", "sourceType", "lastReviewed", "restrictedTags", "noosphere"],
    },
    notes: {
      id: "preserved as exported metadata; this importer matches existing articles by topic+slug",
      slug: "optional; blank or missing values fall back to the markdown filename",
      topicPath: "optional hierarchy; when topic is missing, the last topicPath entry is used",
    },
    exampleFrontmatter: `---
id: exported-article-id
slug: my-article-title
title: My Article Title
topic: engineering
topicPath: [engineering]
tags: [python, backend]
restrictedTags: [health, intimate]  # optional — controls access
createdAt: 2024-01-01T00:00:00Z
updatedAt: 2024-01-02T00:00:00Z
confidence: high
status: published
noosphere:
  entity: article
  schemaVersion: 1
  sourceOfTruth: database
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
  const rl = await rateLimit(request, { windowMs: 60_000, maxRequests: 10, keyPrefix: "import" });
  if (!rl.allowed) return rl.response;

  const auth = await requirePermission(request, [Permissions.WRITE]);
  if (!auth.success) {
    return auth.response;
  }

  const allowedScopes = auth.auth.allowedScopes;

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

  // Enforce compressed size limit to mitigate zip-bomb DoS
  const MAX_ZIP_SIZE = 50 * 1024 * 1024; // 50 MB
  if (zipBuffer.byteLength > MAX_ZIP_SIZE) {
    return NextResponse.json({ error: "Zip file exceeds 50 MB compressed size limit" }, { status: 400 });
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

  // Track uncompressed size to prevent zip-bomb decompression.
  // JSZip's central directory exposes uncompressedSize after loadAsync()
  // without requiring decompression — check before each entry is processed.
  const MAX_UNCOMPRESSED = 200 * 1024 * 1024; // 200 MB total
  let totalUncompressed = 0;

  for (const entry of zipFiles) {
    if (entry.dir || !entry.name.endsWith(".md") || entry.name.includes("README")) continue;

    // Abort early if cumulative uncompressed size would exceed limit.
    // _data is internal JSZip metadata populated from the central directory after
    // loadAsync() — accessed via type assertion since it's not in public types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entrySize = (entry as any)._data?.uncompressedSize ?? 0;
    if (totalUncompressed + entrySize > MAX_UNCOMPRESSED) {
      return NextResponse.json(
        { error: "Zip contents exceed 200 MB uncompressed size limit" },
        { status: 400 }
      );
    }

    let content: string;
    try {
      content = await entry.async("string");
    } catch {
      toImport.push({ filename: entry.name, title: "", slug: "", topicSlug: "", content: "", tags: [], error: "Failed to read file" });
      continue;
    }

    // Update cumulative size after successful decompression
    totalUncompressed += entrySize;

    const parsed = parseNoosphereMarkdown(content);
    if (!parsed.ok) {
      toImport.push({ filename: entry.name, title: "", slug: "", topicSlug: "", content: "", tags: [], error: parsed.error });
      continue;
    }

    const { frontmatter, content: articleContent } = parsed.markdown;
    const title = readMarkdownString(frontmatter, "title") ?? "";
    const topicPath = readMarkdownStringArray(frontmatter, "topicPath");
    const topicSlug = readMarkdownString(frontmatter, "topic") ?? topicPath.at(-1) ?? defaultTopicSlug ?? "";

    if (!title || !articleContent.trim()) {
      toImport.push({ filename: entry.name, title, slug: "", topicSlug, content: articleContent, tags: [], error: "Missing required field: title or content" });
      continue;
    }

    if (!topicSlug) {
      toImport.push({ filename: entry.name, title, slug: "", topicSlug: "", content: articleContent, tags: [], error: "Missing required field: topic" });
      continue;
    }

    // Prefer the shared frontmatter slug. Fall back to filename for legacy imports.
    const slugSource = readMarkdownString(frontmatter, "slug") ?? entry.name.replace(/\.md$/i, "").replace(/.*\//, "");
    const slug = slugSource
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80);

    if (!slug) {
      toImport.push({ filename: entry.name, title, slug: "", topicSlug, content: articleContent, tags: [], error: "Could not derive valid slug from filename" });
      continue;
    }

    const tags = readMarkdownStringArray(frontmatter, "tags");
    const restrictedTags = readMarkdownStringArray(frontmatter, "restrictedTags");

    toImport.push({
      filename: entry.name,
      title,
      topicSlug,
      slug,
      content: articleContent,
      tags,
      excerpt: readMarkdownString(frontmatter, "excerpt"),
      confidence: readMarkdownString(frontmatter, "confidence"),
      status: readMarkdownString(frontmatter, "status"),
      sourceUrl: readMarkdownString(frontmatter, "sourceUrl"),
      sourceType: readMarkdownString(frontmatter, "sourceType"),
      restrictedTags: restrictedTags.length > 0 ? restrictedTags : undefined,
    });
  }

  // Validate topics exist
  for (const article of toImport) {
    if (!article.error && !topicBySlug.has(article.topicSlug)) {
      article.error = `Topic "${article.topicSlug}" not found`;
    }
  }

  // Process imports
  const userId = auth.auth.userId ?? null;
  const userName = auth.auth.name ?? "Importer";

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
          // Scope check: can the caller update this article?
          if (!canAccessScopes(existing.restrictedTags ?? [], allowedScopes)) {
            // Restricted article — caller has no matching scope, skip
            results.skipped++;
            continue;
          }
          // Update existing article
          await tx.article.update({
            where: { id: existing.id },
            data: {
              title: article.title,
              content: article.content,
              excerpt: article.excerpt ?? article.content.slice(0, 160).replace(/[#*`_]/g, ""),
              confidence: validatedConfidence(article.confidence),
              status: validatedStatus(article.status, existing.status),
              restrictedTags: article.restrictedTags ?? [],
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
          confidence: validatedConfidence(article.confidence),
          status: validatedStatus(article.status, "published"),
          sourceUrl: article.sourceUrl ?? null,
          sourceType: article.sourceType ?? "import",
          restrictedTags: article.restrictedTags ?? [],
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

  if (results.imported > 0) {
    await invalidateSearchCache();
  }

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
