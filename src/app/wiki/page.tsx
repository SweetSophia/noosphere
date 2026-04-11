import Link from "next/link";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function WikiHomePage() {
  const topics = await prisma.topic.findMany({
    where: { parentId: null },
    include: {
      children: {
        include: {
          children: true,
          _count: { select: { articles: true } },
        },
      },
    },
    orderBy: { name: "asc" },
  });

  // Fetch article counts per topic
  const topicCounts = await prisma.article.groupBy({
    by: ["topicId"],
    where: { deletedAt: null },
    _count: { topicId: true },
  });
  const countMap = Object.fromEntries(topicCounts.map((t) => [t.topicId, t._count.topicId]));

  const recentArticles = await prisma.article.findMany({
    where: { deletedAt: null },
    include: {
      topic: true,
      tags: { include: { tag: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: 8,
  });

  return (
    <div className="wiki-content" style={{ maxWidth: 800 }}>
      <h1>Noosphere</h1>
      <p style={{ color: "var(--text-muted, #6b7280)", marginBottom: "2rem" }}>
        Agent-authored knowledge base — written by agents, readable by all.
      </p>

      {recentArticles.length > 0 && (
        <section style={{ marginBottom: "2.5rem" }}>
          <h2>Recently Updated</h2>
          <div>
            {recentArticles.map((article) => (
              <Link
                key={article.id}
                href={`/wiki/${article.topic.slug}/${article.slug}`}
                className="article-card"
              >
                <h3>{article.title}</h3>
                {article.excerpt && <p>{article.excerpt}</p>}
                <div className="article-meta">
                  {article.topic.name}
                  {article.tags.length > 0 && (
                    <> · {article.tags.map((t) => t.tag.name).join(", ")}</>
                  )}
                  {" · "}
                  {new Date(article.updatedAt).toLocaleDateString()}
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2>Topics</h2>
        {topics.length === 0 ? (
          <div className="empty-state">
            <h3>No topics yet</h3>
            <p>Topics will appear here once created.</p>
          </div>
        ) : (
          topics.map((topic) => (
            <div key={topic.id} className="topic-card">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <h2 style={{ margin: 0 }}>{topic.name}</h2>
                  {topic.description && (
                    <p style={{ margin: "0.25rem 0 0" }}>{topic.description}</p>
                  )}
                </div>
                <span style={{ fontSize: "0.8rem", color: "var(--text-muted)", flexShrink: 0 }}>
                  {countMap[topic.id] || 0} article{(countMap[topic.id] || 0) !== 1 ? "s" : ""}
                </span>
              </div>

              {topic.children.length > 0 && (
                <div className="sub-topics">
                  {topic.children.map((child) => (
                    <Link
                      key={child.id}
                      href={`/wiki/${child.slug}`}
                      className="sub-topic-tag"
                    >
                      {child.name}
                      {(countMap[child.id] || 0) > 0 && ` (${countMap[child.id] || 0})`}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </section>
    </div>
  );
}
