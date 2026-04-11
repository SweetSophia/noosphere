import Link from "next/link";
import { prisma } from "@/lib/prisma";

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

  if (q) {
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { content: { contains: q, mode: "insensitive" } },
      { excerpt: { contains: q, mode: "insensitive" } },
      { tags: { some: { tag: { name: { contains: q, mode: "insensitive" } } } } },
    ];
  }

  const [results, topics, tags] = await Promise.all([
    q || topic || tag
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

  return (
    <div className="wiki-content" style={{ maxWidth: 900 }}>
      <nav className="breadcrumb">
        <Link href="/wiki">Noosphere</Link>
        <span className="breadcrumb-sep">/</span>
        <span>Search</span>
      </nav>

      <div className="page-toolbar">
        <div>
          <h1 style={{ margin: 0 }}>Search</h1>
          <p className="page-subtitle">Find articles by text, topic, or tag.</p>
        </div>
      </div>

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

        <div style={{ display: "flex", gap: "0.75rem" }}>
          <button type="submit" className="btn btn-primary">Search</button>
          <Link href="/wiki/search" className="btn btn-secondary">Reset</Link>
        </div>
      </form>

      {!q && !topic && !tag ? (
        <div className="empty-state">
          <h3>Start a search</h3>
          <p>Enter a query, pick a topic, or filter by tag.</p>
        </div>
      ) : results.length === 0 ? (
        <div className="empty-state">
          <h3>No matching articles</h3>
          <p>Try a broader query or remove one of the filters.</p>
        </div>
      ) : (
        <section>
          <h2>
            Results
            <span className="result-count">({results.length})</span>
          </h2>
          {results.map((article) => (
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
                  <> · {article.tags.map((entry) => entry.tag.name).join(", ")}</>
                )}
                {" · "}
                {article.author?.name ?? article.authorName ?? "Unknown author"}
                {" · Updated "}
                {new Date(article.updatedAt).toLocaleDateString()}
              </div>
            </Link>
          ))}
        </section>
      )}
    </div>
  );
}
