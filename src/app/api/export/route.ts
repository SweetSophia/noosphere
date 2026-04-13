import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiKey } from "@/lib/api/keys";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import JSZip from "jszip";
import yaml from "js-yaml";

// GET /api/export — Export all articles as a zip of markdown files
// Auth: API key (READ/WRITE/ADMIN) or session (human)
export async function GET(request: NextRequest) {
  const apiAuth = await requireApiKey(request);
  const session = await getServerSession(authOptions);

  if (!apiAuth.authorized && !session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const articles = await prisma.article.findMany({
      where: { deletedAt: null },
      include: {
        topic: { select: { slug: true, name: true } },
        tags: { include: { tag: { select: { name: true, slug: true } } } },
      },
      orderBy: { topic: { name: "asc" } },
    });

    const zip = new JSZip();
    const folder = zip.folder("noosphere-export");

    if (!folder) {
      return NextResponse.json({ error: "Failed to create zip folder" }, { status: 500 });
    }

    for (const article of articles) {
      const frontmatter: Record<string, unknown> = {
        title: article.title,
        topic: article.topic.slug,
        tags: article.tags.map((t) => t.tag.slug),
        createdAt: article.createdAt.toISOString(),
        updatedAt: article.updatedAt.toISOString(),
      };

      if (article.confidence) frontmatter.confidence = article.confidence;
      if (article.status) frontmatter.status = article.status;
      if (article.lastReviewed) frontmatter.lastReviewed = article.lastReviewed.toISOString();
      if (article.sourceUrl) frontmatter.sourceUrl = article.sourceUrl;
      if (article.sourceType) frontmatter.sourceType = article.sourceType;
      if (article.excerpt) frontmatter.excerpt = article.excerpt;

      const fm = yaml.dump(frontmatter, { indent: 2, lineWidth: -1, quotingType: '"' });
      const mdContent = `---\n${fm}---\n\n${article.content}`;
      const filename = `${article.slug}.md`;
      folder.file(filename, mdContent);
    }

    // Add a README
    folder.file(
      "README.md",
      `# Noosphere Export\n\nExported ${articles.length} article(s).\n\n## Format\n\nEach .md file has YAML frontmatter:\n\n\`\`\`yaml\n---\ntitle: Article Title\ntopic: topic-slug\ntags: [tag1, tag2]\ncreatedAt: 2024-01-01T00:00:00Z\n---\n\n# Article Title\n\nContent here...\n\`\`\`\n\n## Topics\n\n${[...new Map(articles.map((a) => [a.topic.slug, a.topic.name])).entries()].map(([slug, name]) => `- ${name} (${slug})`).join("\n")}\n`
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
