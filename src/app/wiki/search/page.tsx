import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { searchArticleIds } from "@/lib/wiki";
import { Breadcrumbs } from "@/components/wiki/Breadcrumbs";
import { PageHeader } from "@/components/wiki/PageHeader";
import { EmptyState } from "@/components/wiki/EmptyState";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{
    q?: string;
    topic?: string;
    tag?: string;
  }>;
}

export default async function SearchPage({ searchParams }: Props) {
  const params = await searchParams;
  const q = (params.q ?? "").trim();
  const topic = (params.topic ?? "").trim();
  const tag = (params.tag ?? "").trim();

  const where: Record<string, unknown> = { deletedAt: null };

  if (topic) {
    where.topic = { slug: topic };
  }

  if (tag) {
    where.tags = { some: { tag: { slug: tag } } };
  }

  const articleIds = q
    ? await searchArticleIds(q, {
        topicSlug: topic || undefined,
        tagSlug: tag || undefined,
        limit: 50,
      })
    : [];

  const [results, topics, tags] = await Promise.all([
    q
      ? articleIds.length
        ? prisma.article.findMany({
            where: { id: { in: articleIds } },
            include: {
              topic: true,
              tags: { include: { tag: true } },
              author: { select: { id: true, name: true } },
            },
          }).then((articles) => {
            const articlesById = new Map(articles.map((article) => [article.id, article]));
            return articleIds
              .map((id) => articlesById.get(id))
              .filter((article): article is (typeof articles)[number] => article !== undefined);
          })
        : Promise.resolve([])
      : topic || tag
        ? prisma.article.findMany({
            where,
            include: {
              topic: true,
              tags: { include: { tag: true } },
              author: { select: { id: true, name: true } },
            },
            orderBy: { updatedAt: "desc" },
            take: 50,
          })
        : Promise.resolve([]),
    prisma.topic.findMany({ orderBy: { name: "asc" } }),
    prisma.tag.findMany({ orderBy: { name: "asc" }, take: 50 }),
  ]);

  const hasQuery = q || topic || tag;

  return (
    <div className="wiki-content">
      <Breadcrumbs
        items={[
          { label: "Noosphere", href: "/wiki" },
          { label: "Search" },
        ]}
      />

      <PageHeader
        eyebrow="Discovery"
        title="Search"
        description="Find articles by text, topic, or tag across the entire wiki."
      />

      <form action="/wiki/search" method="get" className="search-panel">
        <div className="search-grid">
          <div className="form-group">
            <label className="form-label" htmlFor="q">Query</label>
            <input
              id="q"
              name="q"
              type="search"
              defaultValue={q}
              className="form-input"
              placeholder="Search title, content, excerpt, tags"
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="topic">Topic</label>
            <select id="topic" name="topic" className="form-select" defaultValue={topic}>
              <option value="">All topics</option>
              {topics.map((entry) => (
                <option key={entry.id} value={entry.slug}>
                  {entry.name}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="tag">Tag</label>
            <input
              id="tag"
              name="tag"
              type="text"
              list="tag-options"
              defaultValue={tag}
              className="form-input"
              placeholder="deployment"
            />
            <datalist id="tag-options">
              {tags.map((entry) => (
                <option key={entry.id} value={entry.slug}>
                  {entry.name}
                </option>
              ))}
            </datalist>
          </div>
        </div>

        <div className="form-actions-row">
          <button type="submit" className="btn btn-primary">Search</button>
          <Link href="/wiki/search" className="btn btn-secondary">Reset</Link>
        </div>
      </form>

      {!hasQuery ? (
        <EmptyState
          title="Start a search"
          description="Enter a query, pick a topic, or filter by tag to find articles across the wiki."
        />
      ) : results.length === 0 ? (
        <EmptyState
          title="No matching articles"
          description="Try a broader query or remove one of the filters."
        />
      ) : (
        <section className="browse-section browse-section-tight">
          <div className="section-header">
            <div className="section-header-copy">
              <h2 className="section-title">Results</h2>
              <p className="section-subtitle">
                {results.length} article{results.length !== 1 ? "s" : ""} found
                {q && ` for "${q}"`}
              </p>
            </div>
          </div>

          <div className="article-list">
            {results.map((article) => (
              <Link
                key={article.id}
                href={`/wiki/${article.topic.slug}/${article.slug}`}
                className="article-card article-card-rich"
              >
                <div className="article-card-header-row">
                  <span className="article-kicker">{article.topic.name}</span>
                  <span className="article-date">{new Date(article.updatedAt).toLocaleDateString()}</span>
                </div>
                <h3>{article.title}</h3>
                <p>{article.excerpt ?? "Open the article to read the latest revision and linked references."}</p>
                {article.tags.length > 0 ? (
                  <div className="article-tag-row article-tag-row-muted">
                    {article.tags.slice(0, 4).map((entry) => (
                      <span key={entry.tag.id} className="tag-badge">
                        {entry.tag.name}
                      </span>
                    ))}
                  </div>
                ) : null}
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
