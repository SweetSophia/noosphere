export const dynamic = "force-dynamic";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getServerSession } from "next-auth";
import { Breadcrumbs } from "@/components/wiki/Breadcrumbs";
import { EmptyState } from "@/components/wiki/EmptyState";
import { PageHeader } from "@/components/wiki/PageHeader";
import { RestrictedArticleIcon } from "@/components/wiki/RestrictedArticleIcon";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildScopeFilter } from "@/lib/api/auth";
import { articleCardLabel, pluralize, wikiDateFormatter } from "@/lib/wiki-format";

interface Props {
  params: Promise<{ topicSlug: string }>;
}

interface TopicPathNode {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
}

function buildTopicPath(topics: TopicPathNode[], current: TopicPathNode) {
  const topicMap = new Map(topics.map((topic) => [topic.id, topic]));
  const path: TopicPathNode[] = [];
  const seen = new Set<string>();
  let cursor: TopicPathNode | undefined = current;

  while (cursor && !seen.has(cursor.id)) {
    path.unshift(cursor);
    seen.add(cursor.id);
    cursor = cursor.parentId ? topicMap.get(cursor.parentId) : undefined;
  }

  return path;
}

export default async function TopicPage({ params }: Props) {
  const { topicSlug } = await params;

  const session = await getServerSession(authOptions);
  const role = session?.user?.role;
  const canCreateArticle = role === "EDITOR" || role === "ADMIN";

  const topic = await prisma.topic.findUnique({
    where: { slug: topicSlug },
    include: {
      parent: { select: { name: true } },
      children: {
        include: {
          _count: { select: { articles: true, children: true } },
        },
        orderBy: { name: "asc" },
      },
    },
  });

  if (!topic) {
    notFound();
  }

  const allTopics = await prisma.topic.findMany({
    select: { id: true, name: true, slug: true, parentId: true },
  });
  const topicPath = buildTopicPath(allTopics, topic);

  // Unauthenticated users only see unrestricted articles.
  // Human sessions (via NextAuth) always have full access — they bypass restrictions.
  const allowedScopes = session ? ["*"] : undefined;
  const scopeWhere = buildScopeFilter(allowedScopes, { topicId: topic.id, deletedAt: null });

  const articles = await prisma.article.findMany({
    where: scopeWhere,
    include: {
      tags: { include: { tag: true } },
      author: { select: { id: true, name: true } },
    },
    orderBy: { updatedAt: "desc" },
  });
  const hasSubtopics = topic.children.length > 0;

  return (
    <div className="wiki-content topic-page">
      <Breadcrumbs
        items={[
          { label: "Noosphere", href: "/wiki" },
          ...topicPath.map((pathTopic, index) => ({
            label: pathTopic.name,
            href: index === topicPath.length - 1 ? undefined : `/wiki/${pathTopic.slug}`,
          })),
        ]}
      />

      <PageHeader
        eyebrow="Topic"
        title={topic.name}
        description={topic.description ?? "A focused collection of articles and subtopics inside the Noosphere knowledge graph."}
        className="topic-page-hero"
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
              <span>{pluralize(articles.length, "article")}</span>
            </span>
            <span className="page-meta-pill">
              <strong>{topic.children.length}</strong>
              <span>{pluralize(topic.children.length, "subtopic")}</span>
            </span>
            {topic.parent ? (
              <span className="page-meta-pill">
                <strong>{topic.parent.name}</strong>
                <span>parent topic</span>
              </span>
            ) : hasSubtopics ? (
              <span className="page-meta-pill">
                <strong>Root</strong>
                <span>top-level topic</span>
              </span>
            ) : null}
          </div>
        }
      />

      {hasSubtopics && (
        <section className="browse-section browse-section-tight topic-page-section">
          <div className="section-header">
            <div className="section-header-copy">
              <p className="page-eyebrow">Branch outward</p>
              <h2 className="section-title">Subtopics</h2>
              <p className="section-subtitle">Subtopics nested under this branch - open any to see its articles and nested branches.</p>
            </div>
          </div>

          <div className="topic-subtopic-grid">
            {topic.children.map((child) => (
              <Link
                key={child.id}
                href={`/wiki/${child.slug}`}
                className="topic-card topic-subtopic-card"
                aria-label={`Subtopic ${child.name}: ${child._count.articles} direct ${pluralize(child._count.articles, "article")}, ${child._count.children} direct ${pluralize(child._count.children, "subtopic")}`}
              >
                <div className="topic-subtopic-copy">
                  <p className="subtopic-kind" aria-hidden="true">Subtopic</p>
                  <h3>{child.name}</h3>
                  <p>{child.description ?? "Explore the next layer of articles nested under this branch."}</p>
                </div>
                <div className="topic-subtopic-metrics" aria-hidden="true">
                  <div className="topic-subtopic-count">
                    <strong>{child._count.articles}</strong>
                    <span>direct {pluralize(child._count.articles, "article")}</span>
                  </div>
                  <div className="topic-subtopic-count">
                    <strong>{child._count.children}</strong>
                    <span>direct {pluralize(child._count.children, "subtopic")}</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="browse-section browse-section-tight topic-page-section">
        <div className="section-header">
          <div className="section-header-copy">
            <p className="page-eyebrow">Reading list</p>
            <h2 className="section-title">Articles</h2>
            <p className="section-subtitle">Direct articles in this topic, ordered by the most recent update.</p>
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
            {articles.map((article) => {
              const visibleTags = article.tags.slice(0, 5);
              const hiddenTagCount = article.tags.length - visibleTags.length;

              return (
                <Link
                  key={article.id}
                  href={`/wiki/${topic.slug}/${article.slug}`}
                  className="article-card article-card-rich topic-article-card"
                  aria-label={articleCardLabel(article)}
                >
                  <div className="topic-article-main">
                    <div className="article-card-header-row">
                      <span className="article-kicker" aria-hidden="true">{article.author?.name ?? article.authorName ?? "Unknown author"}</span>
                      <span className="article-date" aria-hidden="true">Updated {wikiDateFormatter.format(new Date(article.updatedAt))}</span>
                    </div>
                    <h3>
                      <RestrictedArticleIcon tags={article.restrictedTags} />
                      {article.title}
                    </h3>
                    <p>
                      {article.excerpt ?? "Open the article to read the latest revision, related sources, and linked references."}
                    </p>
                    {article.tags.length > 0 ? (
                      <div className="article-tag-row article-tag-row-muted" aria-hidden="true">
                        {visibleTags.map((entry) => (
                          <span key={entry.tag.id} className="tag-badge">
                            {entry.tag.name}
                          </span>
                        ))}
                        {hiddenTagCount > 0 ? (
                          <span className="tag-badge tag-badge-more">+{hiddenTagCount} more</span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  <div className="topic-article-signals" aria-hidden="true">
                    <span className={`status-badge status-${article.status}`}>{article.status}</span>
                    {article.confidence ? (
                      <span className={`confidence-badge confidence-${article.confidence}`}>
                        {article.confidence} confidence
                      </span>
                    ) : null}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
