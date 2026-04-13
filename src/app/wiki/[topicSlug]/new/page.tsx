export const dynamic = "force-dynamic";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ImageUploadPanel } from "@/components/wiki/ImageUploadPanel";
import { MarkdownPreviewTabs } from "@/components/wiki/MarkdownPreviewTabs";
import { MarkdownToolbar } from "@/components/wiki/MarkdownToolbar";
import { createArticle } from "./actions";

interface Props {
  params: Promise<{ topicSlug: string }>;
}

export default async function NewArticlePage({ params }: Props) {
  const { topicSlug } = await params;

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

  return (
    <div className="wiki-content" style={{ maxWidth: 900 }}>
      <nav className="breadcrumb">
        <Link href="/wiki">Noosphere</Link>
        <span className="breadcrumb-sep">/</span>
        <Link href={`/wiki/${topic.slug}`}>{topic.name}</Link>
        <span className="breadcrumb-sep">/</span>
        <span>New Article</span>
      </nav>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.5rem" }}>
        <h1 style={{ margin: 0 }}>New Article</h1>
        <Link href={`/wiki/${topic.slug}`} className="btn btn-secondary btn-sm">
          Cancel
        </Link>
      </div>

      <ImageUploadPanel targetTextareaId="content" />

      <form action={createArticle.bind(null, topicSlug)}>
        <div className="form-group">
          <label className="form-label" htmlFor="title">Title *</label>
          <input
            id="title"
            name="title"
            type="text"
            className="form-input"
            placeholder="Article title"
            required
          />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="excerpt">Excerpt</label>
          <input
            id="excerpt"
            name="excerpt"
            type="text"
            className="form-input"
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
            placeholder="architecture, api, deployment"
          />
          <p className="form-hint">Comma-separated tags. Existing tags are reused automatically.</p>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="content">Content (Markdown) *</label>
          <MarkdownToolbar targetTextareaId="content" />
          <textarea
            id="content"
            name="content"
            className="form-textarea"
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
            Create Article
          </button>
          <Link href={`/wiki/${topic.slug}`} className="btn btn-secondary">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
