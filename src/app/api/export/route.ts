import { NextRequest, NextResponse } from "next/server";
import { Permissions } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission, buildScopeFilter } from "@/lib/api/auth";
import JSZip from "jszip";
import { rateLimit } from "@/lib/rate-limit";
import { renderNoosphereMarkdown } from "@/lib/markdown/noosphere-markdown";

interface ExportTopicNode {
  id: string;
  slug: string;
  parentId: string | null;
}

function buildExportTopicPath(topicMap: Map<string, ExportTopicNode>, topicId: string): string[] {
  const path: string[] = [];
  let current = topicMap.get(topicId);
  const seen = new Set<string>();

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current.slug);
    current = current.parentId ? topicMap.get(current.parentId) : undefined;
  }

  return path;
}

// GET /api/export — Export all articles as a zip of markdown files
// Auth: API key (READ/WRITE/ADMIN) or session (human)
export async function GET(request: NextRequest) {
  const rl = rateLimit(request, { windowMs: 60_000, maxRequests: 10, keyPrefix: "export" });
  if (!rl.allowed) return rl.response;

  const auth = await requirePermission(request, [Permissions.READ]);
  if (!auth.success) {
    return auth.response;
  }

  const scopeWhere = buildScopeFilter(auth.auth.allowedScopes, { deletedAt: null });

  try {
    const articles = await prisma.article.findMany({
      where: scopeWhere,
      include: {
        topic: { select: { slug: true, name: true } },
        tags: { include: { tag: { select: { name: true, slug: true } } } },
      },
      orderBy: { topic: { name: "asc" } },
    });

    const zip = new JSZip();
    const folder = zip.folder("noosphere-export");
    const exportedAt = new Date().toISOString();
    const topics = await prisma.topic.findMany({
      select: { id: true, slug: true, parentId: true },
    });
    const topicMap = new Map<string, ExportTopicNode>(topics.map((topic) => [topic.id, topic]));

    if (!folder) {
      return NextResponse.json({ error: "Failed to create zip folder" }, { status: 500 });
    }

    for (const article of articles) {
      const topicPath = buildExportTopicPath(topicMap, article.topicId);
      const topicSlug = topicPath.at(-1) ?? article.topic.slug;
      const mdContent = renderNoosphereMarkdown(
        {
          id: article.id,
          slug: article.slug,
          title: article.title,
          topic: topicSlug,
          topicPath: topicPath.length > 0 ? topicPath : [article.topic.slug],
          content: article.content,
          tags: article.tags.map((t) => t.tag.slug),
          restrictedTags: article.restrictedTags,
          excerpt: article.excerpt,
          confidence: article.confidence,
          status: article.status,
          sourceUrl: article.sourceUrl,
          sourceType: article.sourceType,
          lastReviewed: article.lastReviewed,
          createdAt: article.createdAt,
          updatedAt: article.updatedAt,
        },
        { syncedAt: exportedAt }
      );
      const filename = `${article.slug}.md`;
      folder.file(filename, mdContent);
    }

    // Add a README
    folder.file(
      "README.md",
      `# Noosphere Export\n\nExported ${articles.length} article(s).\n\n## Format\n\nEach .md file has YAML frontmatter rendered by the shared Noosphere markdown codec:\n\n\`\`\`yaml\n---\nid: article-id\nslug: article-slug\ntitle: Article Title\ntopic: topic-slug\ntopicPath: [parent-topic, topic-slug]\ntags: [tag1, tag2]\nrestrictedTags: [health, intimate]  # optional — controls access\ncreatedAt: 2024-01-01T00:00:00Z\nupdatedAt: 2024-01-02T00:00:00Z\nnoosphere:\n  entity: article\n  schemaVersion: 1\n  syncedAt: 2024-01-02T00:00:00Z\n  contentHash: sha256:...\n  sourceOfTruth: database\n---\n\n# Article Title\n\nContent here...\n\`\`\`\n\n## Topics\n\n${[...new Map(articles.map((a) => [a.topic.slug, a.topic.name])).entries()].map(([slug, name]) => `- ${name} (${slug})`).join("\n")}\n`
    );

    const buffer = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });

    const timestamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="noosphere-export-${timestamp}.zip"`,
        "Content-Length": String(new Uint8Array(buffer).length),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[GET /api/export]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
