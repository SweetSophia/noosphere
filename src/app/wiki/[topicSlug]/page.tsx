export const dynamic = "force-dynamic";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getServerSession } from "next-auth";
import { Breadcrumbs } from "@/components/wiki/Breadcrumbs";
import { EmptyState } from "@/components/wiki/EmptyState";
import { PageHeader } from "@/components/wiki/PageHeader";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface Props {
  params: Promise<{ topicSlug: string }>;
}

export default async function TopicPage({ params }: Props) {
  const { topicSlug } = await params;

  const session = await getServerSession(authOptions);
  const role = session?.user?.role;
  const canCreateArticle = role === "EDITOR" || role === "ADMIN";

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
    <div className="wiki-content topic-page">
      <Breadcrumbs
        items={[
          { label: "Noosphere", href: "/wiki" },
          ...(topic.parent ? [{ label: topic.parent.name, href: `/wiki/${topic.parent.slug}` }] : []),
          { label: topic.name },
        ]}
      />

      <PageHeader
        eyebrow="Topic"
        title={topic.name}
        description={topic.description ?? "A focused collection of articles and subtopics inside the Noosphere knowledge graph."}
        actions={
          canCreateArticle ? (
            <Link href={`/wiki/${topic.slug}/new`} className="btn btn-primary btn-sm">
              New Article
            </Link>
          ) : null
        }
        meta={
          <div className="page-meta-pills">
            <span className="page-meta-pill">
              <strong>{articles.length}</strong>
              <span>article{articles.length !== 1 ? "s" : ""}</span>
            </span>
            <span className="page-meta-pill">
              <strong>{topic.children.length}</strong>
              <span>subtopic{topic.children.length !== 1 ? "s" : ""}</span>
            </span>
            {topic.parent ? (
              <span className="page-meta-pill">
                <strong>{topic.parent.name}</strong>
                <span>parent topic</span>
              </span>
            ) : null}
          </div>
        }
      />

      {topic.children.length > 0 && (
        <section className="browse-section browse-section-tight">
          <div className="section-header">
            <div className="section-header-copy">
              <p className="page-eyebrow">Branch outward</p>
              <h2 className="section-title">Subtopics</h2>
              <p className="section-subtitle">Jump into narrower branches connected to this topic.</p>
            </div>
          </div>

          <div className="topic-subtopic-grid">
            {topic.children.map((child) => (
              <Link key={child.id} href={`/wiki/${child.slug}`} className="topic-card topic-subtopic-card">
                <div>
                  <p className="topic-tree-kind">Subtopic</p>
                  <h3>{child.name}</h3>
                  <p>{child.description ?? "Explore the next layer of articles nested under this branch."}</p>
                </div>
                <div className="topic-subtopic-count">
                  <strong>{child._count.articles}</strong>
                  <span>article{child._count.articles !== 1 ? "s" : ""}</span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="browse-section browse-section-tight">
        <div className="section-header">
          <div className="section-header-copy">
            <p className="page-eyebrow">Reading list</p>
            <h2 className="section-title">Articles</h2>
            <p className="section-subtitle">The latest pages in this topic, ordered by most recent update.</p>
          </div>
          {articles.length > 0 ? <span className="result-count">{articles.length} total</span> : null}
        </div>

        {articles.length === 0 ? (
          <EmptyState
            title="No articles yet"
            description="Articles in this topic will appear here once they are created."
            action={
              canCreateArticle ? (
                <Link href={`/wiki/${topic.slug}/new`} className="btn btn-primary btn-sm">
                  Create the first article
                </Link>
              ) : null
            }
          />
        ) : (
          <div className="article-list">
            {articles.map((article) => (
              <Link
                key={article.id}
                href={`/wiki/${topic.slug}/${article.slug}`}
                className="article-card article-card-rich"
              >
                <div className="article-card-header-row">
                  <span className="article-kicker">{article.author?.name ?? article.authorName ?? "Unknown author"}</span>
                  <span className="article-date">Updated {new Date(article.updatedAt).toLocaleDateString()}</span>
                </div>
                <h3>{article.title}</h3>
                <p>
                  {article.excerpt ?? "Open the article to read the latest revision, related sources, and linked references."}
                </p>
                {article.tags.length > 0 ? (
                  <div className="article-tag-row article-tag-row-muted">
                    {article.tags.map((entry) => (
                      <span key={entry.tag.id} className="tag-badge">
                        {entry.tag.name}
                      </span>
                    ))}
                  </div>
                ) : null}
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
