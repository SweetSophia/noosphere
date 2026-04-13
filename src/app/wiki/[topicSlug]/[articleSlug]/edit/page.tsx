export const dynamic = "force-dynamic";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { DeleteArticleForm } from "@/components/wiki/DeleteArticleForm";
import { ImageUploadPanel } from "@/components/wiki/ImageUploadPanel";
import { MarkdownPreviewTabs } from "@/components/wiki/MarkdownPreviewTabs";
import { MarkdownToolbar } from "@/components/wiki/MarkdownToolbar";
import { deleteArticle, saveArticle } from "./actions";

interface Props {
  params: Promise<{ topicSlug: string; articleSlug: string }>;
}

export default async function EditArticlePage({ params }: Props) {
  const { topicSlug, articleSlug } = await params;

  // Page-level auth check
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    redirect("/wiki/login");
  }
  const role = (session.user as { role?: string }).role;
  if (role !== "EDITOR" && role !== "ADMIN") {
    redirect("/wiki");
  }

  const topic = await prisma.topic.findUnique({ where: { slug: topicSlug } });
  if (!topic) notFound();

  const article = await prisma.article.findFirst({
    where: { topicId: topic.id, slug: articleSlug, deletedAt: null },
    include: {
      tags: { include: { tag: true } },
    },
  });

  if (!article) notFound();

  return (
    <div className="wiki-content" style={{ maxWidth: 900 }}>
      <nav className="breadcrumb">
        <Link href="/wiki">Noosphere</Link>
        <span className="breadcrumb-sep">/</span>
        <Link href={`/wiki/${topic.slug}`}>{topic.name}</Link>
        <span className="breadcrumb-sep">/</span>
        <Link href={`/wiki/${topic.slug}/${article.slug}`}>{article.title}</Link>
        <span className="breadcrumb-sep">/</span>
        <span>Edit</span>
      </nav>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.5rem", gap: "1rem", flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>Edit Article</h1>
        <div className="page-actions">
          <DeleteArticleForm action={deleteArticle.bind(null, topicSlug, articleSlug)} articleId={article.id} />
          <Link
            href={`/wiki/${topic.slug}/${article.slug}`}
            className="btn btn-secondary btn-sm"
          >
            Cancel
          </Link>
        </div>
      </div>

      <ImageUploadPanel targetTextareaId="content" />

      <form action={saveArticle.bind(null, topicSlug, articleSlug)}>
        <div className="form-group">
          <label className="form-label" htmlFor="title">Title</label>
          <input
            id="title"
            name="title"
            type="text"
            className="form-input"
            defaultValue={article.title}
            placeholder="Article title"
          />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="excerpt">Excerpt</label>
          <input
            id="excerpt"
            name="excerpt"
            type="text"
            className="form-input"
            defaultValue={article.excerpt ?? ""}
            placeholder="Brief summary used in lists and search results"
          />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="tags">Tags</label>
          <input
            id="tags"
            name="tags"
            type="text"
            className="form-input"
            defaultValue={article.tags.map((entry) => entry.tag.name).join(", ")}
            placeholder="architecture, api, deployment"
          />
          <p className="form-hint">Comma-separated tags. Existing tags are reused automatically.</p>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="content">Content (Markdown)</label>
          <MarkdownToolbar targetTextareaId="content" />
          <textarea
            id="content"
            name="content"
            className="form-textarea"
            defaultValue={article.content}
            placeholder="Write your article in Markdown..."
            required
          />
          <p className="form-hint">
            Supports GitHub-flavored Markdown. Code blocks with syntax highlighting.
          </p>
          <MarkdownPreviewTabs targetTextareaId="content" />
        </div>

        <div style={{ display: "flex", gap: "0.75rem" }}>
          <button type="submit" className="btn btn-primary">
            Save Changes
          </button>
          <Link
            href={`/wiki/${topic.slug}/${article.slug}`}
            className="btn btn-secondary"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
