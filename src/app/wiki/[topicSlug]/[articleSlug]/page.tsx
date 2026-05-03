export const dynamic = "force-dynamic";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getServerSession } from "next-auth";
import { Breadcrumbs } from "@/components/wiki/Breadcrumbs";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { DeleteArticleForm } from "@/components/wiki/DeleteArticleForm";
import { PageHeader } from "@/components/wiki/PageHeader";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { deleteArticle } from "./edit/actions";

interface Props {
  params: Promise<{ topicSlug: string; articleSlug: string }>;
}

export default async function ArticlePage({ params }: Props) {
  const { topicSlug, articleSlug } = await params;

  const session = await getServerSession(authOptions);
  const role = session?.user?.role;
  const canEdit = role === "EDITOR" || role === "ADMIN";
  const canDelete = role === "ADMIN";

  const topic = await prisma.topic.findUnique({ where: { slug: topicSlug } });
  if (!topic) notFound();

  const article = await prisma.article.findFirst({
    where: { topicId: topic.id, slug: articleSlug, deletedAt: null },
    include: {
      tags: { include: { tag: true } },
      author: { select: { id: true, name: true } },
      revisions: {
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { createdAt: true },
      },
      relatedTo: {
        include: {
          target: {
            select: { id: true, title: true, slug: true, topic: { select: { slug: true } } },
          },
        },
      },
    },
  });

  if (!article) notFound();

  let safeSourceUrl: string | null = null;

  if (article.sourceUrl) {
    try {
      const parsed = new URL(article.sourceUrl);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        safeSourceUrl = article.sourceUrl;
      }
    } catch {
      safeSourceUrl = null;
    }
  }

  return (
    <div className="wiki-content article-page">
      <Breadcrumbs
        items={[
          { label: "Noosphere", href: "/wiki" },
          { label: topic.name, href: `/wiki/${topic.slug}` },
          { label: article.title },
        ]}
      />

      <header className="article-header article-hero">
        <PageHeader
          eyebrow="Article"
          title={article.title}
          description={article.excerpt ?? "Read the current article body, linked references, and recent revision trail."}
          actions={
            <div className="article-actions-panel">
              <Link href={`/wiki/${topic.slug}/${article.slug}/history`} className="btn btn-secondary btn-sm">
                History
              </Link>
              {canEdit ? (
                <Link href={`/wiki/${topic.slug}/${article.slug}/edit`} className="btn btn-primary btn-sm">
                  Edit Article
                </Link>
              ) : session?.user ? null : (
                <Link href="/wiki/login" className="btn btn-secondary btn-sm">
                  Sign In to Edit
                </Link>
              )}
              {canDelete ? (
                <DeleteArticleForm action={deleteArticle.bind(null, topic.slug, article.slug)} articleId={article.id} />
              ) : null}
            </div>
          }
          meta={
            <div className="page-meta-pills">
              <span className="page-meta-pill">
                <strong>{article.author?.name ?? article.authorName ?? "Unknown"}</strong>
                <span>author</span>
              </span>
              <span className="page-meta-pill">
                <strong>{new Date(article.updatedAt).toLocaleDateString()}</strong>
                <span>last updated</span>
              </span>
              {article.revisions[0] ? (
                <span className="page-meta-pill">
                  <strong>{new Date(article.revisions[0].createdAt).toLocaleDateString()}</strong>
                  <span>latest revision</span>
                </span>
              ) : null}
            </div>
          }
        />

        {article.tags.length > 0 ? (
          <div className="article-tag-row article-tag-row-interactive">
            {article.tags.map((entry) => (
              <Link key={entry.tag.id} href={`/wiki/search?tag=${entry.tag.slug}`} className="tag-badge tag-link">
                #{entry.tag.name}
              </Link>
            ))}
          </div>
        ) : null}

        <div className="article-detail-grid">
          <section className="article-detail-card">
            <p className="article-detail-label">Signals</p>
            <div className="article-badge-row">
              {article.status && article.status !== "published" ? (
                <span className={`status-badge status-${article.status}`}>{article.status}</span>
              ) : (
                <span className="status-badge status-published">published</span>
              )}
              {article.confidence ? (
                <span className={`confidence-badge confidence-${article.confidence}`}>
                  {article.confidence} confidence
                </span>
              ) : null}
              {article.lastReviewed ? (
                <span className="article-inline-meta">Reviewed {new Date(article.lastReviewed).toLocaleDateString()}</span>
              ) : null}
            </div>
            <div className="article-link-list">
              <Link href={`/wiki/${topic.slug}`} className="sub-topic-tag">
                In topic: {topic.name}
              </Link>
              {safeSourceUrl ? (
                <a href={safeSourceUrl} target="_blank" rel="noopener noreferrer" className="sub-topic-tag">
                  View source
                </a>
              ) : null}
            </div>
          </section>

          <section className="article-detail-card">
            <p className="article-detail-label">Connected pages</p>
            {article.relatedTo.length > 0 ? (
              <div className="article-link-list">
                {article.relatedTo.map((rel) => (
                  <Link
                    key={rel.target.id}
                    href={`/wiki/${rel.target.topic.slug}/${rel.target.slug}`}
                    className="sub-topic-tag"
                  >
                    {rel.target.title}
                  </Link>
                ))}
              </div>
            ) : (
              <p className="article-inline-meta">No related articles linked yet.</p>
            )}
          </section>
        </div>

        <p className="article-action-hint">
          {canDelete
            ? "Admins can edit and move this article to trash."
            : canEdit
              ? "You can edit this article. Only admins can move articles to trash."
              : session?.user
                ? "You currently have read-only access to this article."
                : "Sign in with an editor account to update this article."}
        </p>
      </header>

      <article className="markdown-body article-prose">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            code({ className, children, ...props }) {
              const inline = !className;
              const match = /language-(\w+)/.exec(className || "");
              if (!inline && match) {
                return (
                  <SyntaxHighlighter
                    style={oneDark}
                    language={match[1]}
                    PreTag="div"
                  >
                    {String(children).replace(/\n$/, "")}
                  </SyntaxHighlighter>
                );
              }
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            },
          }}
        >
          {article.content}
        </ReactMarkdown>
      </article>

      <section className="revision-summary-card">
        <div className="section-header">
          <div className="section-header-copy">
            <p className="page-eyebrow">Revision trail</p>
            <h2 className="section-title">Recent history</h2>
            <p className="section-subtitle">Latest saved changes for this article.</p>
          </div>
          <Link href={`/wiki/${topic.slug}/${article.slug}/history`} className="btn btn-secondary btn-sm">
            View Full History
          </Link>
        </div>
        <div className="revision-summary-list">
          {article.revisions.map((revision, index) => (
            <div key={revision.createdAt.toISOString()} className="revision-summary-item">
              <strong>Revision {article.revisions.length - index}</strong>
              <span className="text-muted">{new Date(revision.createdAt).toLocaleString()}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
