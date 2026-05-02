import Link from "next/link";
import { EmptyState } from "@/components/wiki/EmptyState";
import { PageHeader } from "@/components/wiki/PageHeader";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

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

interface TopicRenderNode {
  node: TopicNode;
  articleCount: number;
  descendantCount: number;
  children: TopicRenderNode[];
}

function buildTopicRenderNode(node: TopicNode, countMap: ArticleCountMap): TopicRenderNode {
  const children = node.children.map((child) => buildTopicRenderNode(child, countMap));

  return {
    node,
    articleCount:
      (countMap[node.id] ?? 0) + children.reduce((total, child) => total + child.articleCount, 0),
    descendantCount:
      node.children.length + children.reduce((total, child) => total + child.descendantCount, 0),
    children,
  };
}

function TopicTreeNode({ tree }: { tree: TopicRenderNode }) {
  const { node, articleCount, descendantCount, children } = tree;
  const hasChildren = children.length > 0;

  return (
    <div className="topic-tree-node">
      <div className="topic-card topic-tree-card">
        <div className="topic-tree-copy">
          <p className="topic-tree-kind">{hasChildren ? "Topic cluster" : "Leaf topic"}</p>
          <h2 className="topic-tree-title">
            <Link href={`/wiki/${node.slug}`}>{node.name}</Link>
          </h2>
          <p className="topic-tree-description">
            {node.description ?? "A focused pocket of the wiki ready for articles, references, and linked subtopics."}
          </p>
        </div>

        <div className="topic-tree-metrics" aria-label={`${node.name} metrics`}>
          <div className="topic-tree-stat">
            <strong>{articleCount}</strong>
            <span>article{articleCount !== 1 ? "s" : ""}</span>
          </div>
          <div className="topic-tree-stat">
            <strong>{descendantCount}</strong>
            <span>subtopic{descendantCount !== 1 ? "s" : ""}</span>
          </div>
        </div>
      </div>

      {hasChildren && (
        <div className="topic-tree-children">
          {children.map((child) => (
            <TopicTreeNode key={child.node.id} tree={child} />
          ))}
        </div>
      )}
    </div>
  );
}

export default async function WikiHomePage() {
  const [allTopics, topicCounts, recentArticles] = await Promise.all([
    prisma.topic.findMany({ orderBy: { name: "asc" } }),
    prisma.article.groupBy({
      by: ["topicId"],
      where: { deletedAt: null },
      _count: { topicId: true },
    }),
    prisma.article.findMany({
      where: { deletedAt: null },
      include: {
        topic: true,
        tags: { include: { tag: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 8,
    }),
  ]);

  const countMap: ArticleCountMap = Object.fromEntries(topicCounts.map((t) => [t.topicId, t._count.topicId]));

  const topicMap = new Map<string, TopicNode & { parentId: string | null }>();
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

  const totalArticles = Object.values(countMap).reduce((total, count) => total + count, 0);
  const topicTree = roots.map((topic) => buildTopicRenderNode(topic, countMap));

  return (
    <div className="wiki-content wiki-home">
      <PageHeader
        eyebrow="Knowledge atlas"
        title="Noosphere"
        description="Agent-authored documentation with a calmer information hierarchy: browse live updates, scan topic clusters, and dive straight into the wiki's deepest branches."
        meta={
          <div className="page-meta-pills">
            <span className="page-meta-pill">
              <strong>{totalArticles}</strong>
              <span>published articles</span>
            </span>
            <span className="page-meta-pill">
              <strong>{allTopics.length}</strong>
              <span>topics mapped</span>
            </span>
            <span className="page-meta-pill">
              <strong>{recentArticles.length}</strong>
              <span>recent updates surfaced</span>
            </span>
          </div>
        }
      />

      {recentArticles.length > 0 && (
        <section className="browse-section">
          <div className="section-header">
            <div className="section-header-copy">
              <p className="page-eyebrow">Fresh signal</p>
              <h2 className="section-title">Recently updated</h2>
              <p className="section-subtitle">The newest edits, additions, and refinements across the wiki.</p>
            </div>
            <div className="section-actions">
              <Link href="/wiki/search" className="btn btn-secondary btn-sm">
                Search everything
              </Link>
            </div>
          </div>

          <div className="recent-updates-grid">
            {recentArticles.map((article) => (
              <Link
                key={article.id}
                href={`/wiki/${article.topic.slug}/${article.slug}`}
                className="article-card article-card-grid"
              >
                <div className="article-card-header-row">
                  <span className="article-kicker">{article.topic.name}</span>
                  <span className="article-date">{new Date(article.updatedAt).toLocaleDateString()}</span>
                </div>
                <h3>{article.title}</h3>
                <p>
                  {article.excerpt ?? "Open the latest revision to read the current summary and linked references."}
                </p>
                {article.tags.length > 0 ? (
                  <div className="article-tag-row article-tag-row-muted">
                    {article.tags.slice(0, 3).map((tag) => (
                      <span key={tag.tag.id} className="tag-badge">
                        {tag.tag.name}
                      </span>
                    ))}
                  </div>
                ) : null}
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="browse-section">
        <div className="section-header">
          <div className="section-header-copy">
            <p className="page-eyebrow">Topic map</p>
            <h2 className="section-title">Browse the knowledge tree</h2>
            <p className="section-subtitle">Follow parent-to-child branches to see how subjects cluster and where the richest pockets of documentation live.</p>
          </div>
        </div>

        {roots.length === 0 ? (
          <EmptyState title="No topics yet" description="Topics will appear here once they are created." />
        ) : (
          <div className="topic-tree">{topicTree.map((topic) => <TopicTreeNode key={topic.node.id} tree={topic} />)}</div>
        )}
      </section>
    </div>
  );
}
