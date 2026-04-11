export const dynamic = "force-dynamic";
import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";

interface Props {
  params: Promise<{ topicSlug: string }>;
}

export default async function TopicPage({ params }: Props) {
  const { topicSlug } = await params;

  const topic = await prisma.topic.findUnique({
    where: { slug: topicSlug },
    include: {
      parent: true,
      children: {
        include: {
          _count: { select: { articles: true } },
        },
      },
    },
  });

  if (!topic) {
    notFound();
  }

  const articles = await prisma.article.findMany({
    where: { topicId: topic.id, deletedAt: null },
    include: {
      tags: { include: { tag: true } },
      author: { select: { id: true, name: true } },
    },
    orderBy: { updatedAt: "desc" },
  });

  return (
    <div className="wiki-content" style={{ maxWidth: 800 }}>
      {/* Breadcrumb */}
      <nav className="breadcrumb">
        <Link href="/wiki">Noosphere</Link>
        {topic.parent && (
          <>
            <span className="breadcrumb-sep">/</span>
            <Link href={`/wiki/${topic.parent.slug}`}>{topic.parent.name}</Link>
          </>
        )}
        <span className="breadcrumb-sep">/</span>
        <span>{topic.name}</span>
      </nav>

      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "1.5rem", gap: "1rem" }}>
        <div>
          <h1 style={{ margin: 0 }}>{topic.name}</h1>
          {topic.description && (
            <p style={{ color: "var(--text-muted, #6b7280)", marginTop: "0.4rem" }}>
              {topic.description}
            </p>
          )}
        </div>
        <Link href={`/wiki/${topic.slug}/new`} className="btn btn-primary btn-sm">
          New Article
        </Link>
      </div>

      {/* Sub-topics */}
      {topic.children.length > 0 && (
        <section style={{ marginBottom: "2rem" }}>
          <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.75rem" }}>Sub Topics</h2>
          <div className="sub-topics">
            {topic.children.map((child) => (
              <Link key={child.id} href={`/wiki/${child.slug}`} className="sub-topic-tag">
                {child.name}
                {child._count.articles > 0 && ` (${child._count.articles})`}
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Articles */}
      <section>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "1rem" }}>
          Articles
          {articles.length > 0 && (
            <span style={{ fontWeight: 400, color: "var(--text-muted)", marginLeft: "0.5rem", fontSize: "0.85rem" }}>
              ({articles.length})
            </span>
          )}
        </h2>

        {articles.length === 0 ? (
          <div className="empty-state">
            <h3>No articles yet</h3>
            <p>Articles in this topic will appear here.</p>
          </div>
        ) : (
          articles.map((article) => (
            <Link
              key={article.id}
              href={`/wiki/${topic.slug}/${article.slug}`}
              className="article-card"
            >
              <h3>{article.title}</h3>
              {article.excerpt && <p>{article.excerpt}</p>}
              <div className="article-meta">
                {article.author?.name ?? article.authorName ?? "Unknown author"}
                {article.tags.length > 0 && (
                  <> · {article.tags.map((t) => t.tag.name).join(", ")}</>
                )}
                {" · "}
                Updated {new Date(article.updatedAt).toLocaleDateString()}
              </div>
            </Link>
          ))
        )}
      </section>
    </div>
  );
}
