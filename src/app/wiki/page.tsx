import Link from "next/link";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// Types
interface TopicNode {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  children: TopicNode[];
}

interface ArticleCountMap {
  [topicId: string]: number;
}

// Recursive component: renders a topic card and all its nested children
function TopicNode({ node, countMap, depth = 0 }: { node: TopicNode; countMap: ArticleCountMap; depth?: number }) {
  const hasChildren = node.children.length > 0;
  const count = countMap[node.id] ?? 0;

  return (
    <div
      className="topic-card"
      style={{
        marginLeft: depth > 0 ? "1.25rem" : 0,
        borderLeft: depth > 0 ? "2px solid var(--border-color, #e5e7eb)" : undefined,
        paddingLeft: depth > 0 ? "1rem" : 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: depth === 0 ? "1.25rem" : "1rem" }}>
            <Link href={`/wiki/${node.slug}`} style={{ color: "inherit", textDecoration: "none" }}>
              {node.name}
            </Link>
          </h2>
          {node.description && (
            <p style={{ margin: "0.25rem 0 0", color: "var(--text-muted, #6b7280)", fontSize: "0.875rem" }}>
              {node.description}
            </p>
          )}
        </div>
        <span style={{ fontSize: "0.75rem", color: "var(--text-muted, #6b7280)", flexShrink: 0 }}>
          {count} article{count !== 1 ? "s" : ""}
        </span>
      </div>

      {hasChildren && (
        <div className="sub-topics" style={{ marginTop: "0.5rem" }}>
          {node.children.map((child) => (
            <TopicNode key={child.id} node={child} countMap={countMap} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export default async function WikiHomePage() {
  // Fetch ALL topics (no depth limit in query)
  const allTopics = await prisma.topic.findMany({
    include: {
      _count: { select: { articles: true } },
    },
    orderBy: { name: "asc" },
  });

  // Get article counts per topic (excluding soft-deleted)
  const topicCounts = await prisma.article.groupBy({
    by: ["topicId"],
    where: { deletedAt: null },
    _count: { topicId: true },
  });
  const countMap: ArticleCountMap = Object.fromEntries(
    topicCounts.map((t) => [t.topicId, t._count.topicId])
  );

  // Build tree in JS — unlimited nesting depth
  const topicMap = new Map<string, TopicNode & { _count: { articles: number } }>();
  const roots: TopicNode[] = [];

  for (const topic of allTopics) {
    topicMap.set(topic.id, { ...topic, children: [] });
  }

  for (const topic of allTopics) {
    const node = topicMap.get(topic.id)!;
    if (topic.parentId && topicMap.has(topic.parentId)) {
      topicMap.get(topic.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

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
        {roots.length === 0 ? (
          <div className="empty-state">
            <h3>No topics yet</h3>
            <p>Topics will appear here once created.</p>
          </div>
        ) : (
          roots.map((topic) => (
            <TopicNode key={topic.id} node={topic} countMap={countMap} depth={0} />
          ))
        )}
      </section>
    </div>
  );
}
