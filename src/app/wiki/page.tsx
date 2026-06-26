import Link from "next/link";
import { getServerSession } from "next-auth";
import type { Prisma } from "@prisma/client";
import { EmptyState } from "@/components/wiki/EmptyState";
import { PageHeader } from "@/components/wiki/PageHeader";
import { RestrictedArticleIcon } from "@/components/wiki/RestrictedArticleIcon";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { loadWikiHomeData, type WikiHomeDb, type WikiHomeTopic } from "@/lib/wiki-home";
import { articleCardLabel, pluralize, wikiDateFormatter } from "@/lib/wiki-format";

export const dynamic = "force-dynamic";

interface TopicNode extends Omit<WikiHomeTopic, "parentId"> {
  children: TopicNode[];
}

interface ArticleCountMap {
  [topicId: string]: number;
}

interface TopicRenderNode {
  node: TopicNode;
  directArticleCount: number;
  articleCount: number;
  descendantCount: number;
  children: TopicRenderNode[];
}

type WikiHomeArticle = Prisma.ArticleGetPayload<{
  include: {
    topic: true;
    tags: { include: { tag: true } };
  };
}>;

function buildTopicRenderNode(node: TopicNode, countMap: ArticleCountMap): TopicRenderNode {
  const children = node.children.map((child) => buildTopicRenderNode(child, countMap));
  const directArticleCount = countMap[node.id] ?? 0;

  return {
    node,
    directArticleCount,
    articleCount: directArticleCount + children.reduce((total, child) => total + child.articleCount, 0),
    descendantCount:
      node.children.length + children.reduce((total, child) => total + child.descendantCount, 0),
    children,
  };
}

function countBranchTopics(nodes: TopicRenderNode[]): number {
  return nodes.reduce(
    (total, topic) =>
      total + (topic.children.length > 0 ? 1 : 0) + countBranchTopics(topic.children),
    0,
  );
}

function TopicTreeNode({ tree, depth = 0 }: { tree: TopicRenderNode; depth?: number }) {
  const { node, directArticleCount, articleCount, descendantCount, children } = tree;
  const hasChildren = children.length > 0;

  return (
    <div className="topic-tree-node" data-depth={depth}>
      <Link
        href={`/wiki/${node.slug}`}
        className="topic-card topic-tree-card"
        aria-label={`${node.name}: ${directArticleCount} direct ${pluralize(directArticleCount, "article")}, ${articleCount} total ${pluralize(articleCount, "article")} in tree, ${descendantCount} ${pluralize(descendantCount, "subtopic")}`}
      >
        <div className="topic-tree-copy">
          <p className="topic-tree-kind" aria-hidden="true">
            {hasChildren ? "Topic cluster" : "Leaf topic"}
            {depth > 0 ? <span aria-hidden="true">Level {depth}</span> : null}
          </p>
          <h2 className="topic-tree-title">
            <span>{node.name}</span>
          </h2>
          <p className="topic-tree-description">
            {node.description ?? "A focused pocket of the wiki ready for articles, references, and linked subtopics."}
          </p>
          <div className="topic-tree-meta meta-row">
            <span>{directArticleCount} direct article{directArticleCount !== 1 ? "s" : ""}</span>
          </div>
        </div>

        <div className="topic-tree-metrics" aria-hidden="true">
          <div className="topic-tree-stat">
            <strong>{articleCount}</strong>
            <span>total article{articleCount !== 1 ? "s" : ""}</span>
          </div>
          <div className="topic-tree-stat">
            <strong>{descendantCount}</strong>
            <span>subtopic{descendantCount !== 1 ? "s" : ""}</span>
          </div>
        </div>
      </Link>

      {hasChildren && (
        <div className="topic-tree-children">
          {children.map((child) => (
            <TopicTreeNode key={child.node.id} tree={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export default async function WikiHomePage() {
  const session = await getServerSession(authOptions);
  const isAdmin = session?.user?.role === "ADMIN";
  // Unauthenticated users only see unrestricted articles.
  // Human sessions always have full access — they bypass restrictions.
  const allowedScopes = session ? ["*"] : undefined;
  const { allTopics, topicCounts, recentArticles } = await loadWikiHomeData<WikiHomeArticle>(
    prisma as unknown as WikiHomeDb<WikiHomeArticle>,
    allowedScopes,
  );

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
  const branchTopics = countBranchTopics(topicTree);
  const latestArticle = recentArticles[0];
  const secondaryArticles = recentArticles.slice(1);

  return (
    <div className="wiki-content wiki-home">
      <PageHeader
        eyebrow="Knowledge atlas"
        title="Noosphere"
        description="Agent-authored documentation with clear topic paths, readable update trails, and fewer dead ends between question and answer."
        className="wiki-home-hero"
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
              <strong>{branchTopics}</strong>
              <span>branch topics</span>
            </span>
          </div>
        }
        actions={
          isAdmin ? (
            <div className="cluster">
              <Link href="/wiki/admin/topics" className="btn btn-secondary btn-sm">
                New Topic
              </Link>
              <Link href="/wiki/admin/keys" className="btn btn-secondary btn-sm">
                API Keys
              </Link>
            </div>
          ) : null
        }
      />

      {recentArticles.length > 0 && (
        <section className="browse-section wiki-home-section wiki-home-recent">
          <div className="section-header">
            <div className="section-header-copy">
              <p className="page-eyebrow">Fresh signal</p>
              <h2 className="section-title">Recently updated</h2>
              <p className="section-subtitle">The newest edits, additions, and refinements are separated from the topic map so the landing page stays easy to scan.</p>
            </div>
            <div className="section-actions">
              <Link href="/wiki/search" className="btn btn-secondary btn-sm">
                Search everything
              </Link>
            </div>
          </div>

          <div className="home-updates-layout">
            {latestArticle ? (
              <Link
                href={`/wiki/${latestArticle.topic.slug}/${latestArticle.slug}`}
                className="article-card article-card-featured home-featured-update"
                aria-label={articleCardLabel({ ...latestArticle, topicName: latestArticle.topic.name })}
              >
                <div className="article-card-header-row">
                  <span className="article-kicker" aria-hidden="true">{latestArticle.topic.name}</span>
                  <span className="article-date" aria-hidden="true">{wikiDateFormatter.format(new Date(latestArticle.updatedAt))}</span>
                </div>
                <h3>
                  <RestrictedArticleIcon tags={latestArticle.restrictedTags} />
                  {latestArticle.title}
                </h3>
                <p>
                  {latestArticle.excerpt ?? "Open the latest revision to read the current summary and linked references."}
                </p>
                {latestArticle.tags.length > 0 ? (
                  <div className="article-tag-row article-tag-row-muted" aria-hidden="true">
                    {latestArticle.tags.slice(0, 4).map((tag) => (
                      <span key={tag.tag.id} className="tag-badge">
                        {tag.tag.name}
                      </span>
                    ))}
                  </div>
                ) : null}
              </Link>
            ) : null}

            {secondaryArticles.length > 0 ? (
              <div className="home-update-list">
                {secondaryArticles.map((article) => (
                  <Link
                    key={article.id}
                    href={`/wiki/${article.topic.slug}/${article.slug}`}
                    className="article-card article-card-compact home-update-card"
                    aria-label={articleCardLabel({ ...article, topicName: article.topic.name })}
                  >
                    <div className="article-card-header-row">
                      <span className="article-kicker" aria-hidden="true">{article.topic.name}</span>
                      <span className="article-date" aria-hidden="true">{wikiDateFormatter.format(new Date(article.updatedAt))}</span>
                    </div>
                    <h3>
                      <RestrictedArticleIcon tags={article.restrictedTags} />
                      {article.title}
                    </h3>
                    <p>{article.excerpt ?? "Open the latest revision to read the current summary and linked references."}</p>
                  </Link>
                ))}
              </div>
            ) : null}
          </div>
        </section>
      )}

      <section className="browse-section wiki-home-section wiki-home-topics">
        <div className="section-header">
          <div className="section-header-copy">
            <p className="page-eyebrow">Topic map</p>
            <h2 className="section-title">Browse the knowledge tree</h2>
            <p className="section-subtitle">Parent topics stay visually anchored while child topics step inward, making the tree readable without turning it into a wall of tags.</p>
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
