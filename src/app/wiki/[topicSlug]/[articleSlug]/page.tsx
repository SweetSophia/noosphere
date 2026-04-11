export const dynamic = "force-dynamic";
import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { DeleteArticleForm } from "@/components/wiki/DeleteArticleForm";
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

  const topic = await prisma.topic.findUnique({ where: { slug: topicSlug } });
  if (!topic) notFound();

  const article = await prisma.article.findFirst({
    where: { topicId: topic.id, slug: articleSlug, deletedAt: null },
    include: {
      tags: { include: { tag: true } },
      author: { select: { id: true, name: true } },
      revisions: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { createdAt: true },
      },
    },
  });

  if (!article) notFound();

  return (
    <div className="wiki-content" style={{ maxWidth: 800 }}>
      {/* Breadcrumb */}
      <nav className="breadcrumb">
        <Link href="/wiki">Noosphere</Link>
        <span className="breadcrumb-sep">/</span>
        <Link href={`/wiki/${topic.slug}`}>{topic.name}</Link>
        <span className="breadcrumb-sep">/</span>
        <span>{article.title}</span>
      </nav>

      {/* Article header */}
      <header className="article-header">
        <h1>{article.title}</h1>
        <div className="article-meta-bar">
          <span>
            By {article.author?.name ?? article.authorName ?? "Unknown"}
          </span>
          <span>Updated {new Date(article.updatedAt).toLocaleDateString()}</span>
          {article.revisions[0] && (
            <span>
              Last edited{" "}
              {new Date(article.revisions[0].createdAt).toLocaleDateString()}
            </span>
          )}
        </div>
        {article.tags.length > 0 && (
          <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
            {article.tags.map((t) => (
              <span key={t.tag.id} className="tag-badge">
                {t.tag.name}
              </span>
            ))}
          </div>
        )}
        <div style={{ marginTop: "1rem" }} className="page-actions">
          <Link
            href={`/wiki/${topic.slug}/${article.slug}/edit`}
            className="btn btn-secondary btn-sm"
          >
            Edit
          </Link>
          <DeleteArticleForm action={deleteArticle.bind(null, topic.slug, article.slug)} articleId={article.id} />
        </div>
      </header>

      {/* Article body */}
      <article className="markdown-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            code({ node, className, children, ...props }) {
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
    </div>
  );
}
