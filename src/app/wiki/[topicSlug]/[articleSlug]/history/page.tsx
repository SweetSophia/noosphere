export const dynamic = "force-dynamic";
import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";

interface Props {
  params: Promise<{ topicSlug: string; articleSlug: string }>;
}

export default async function ArticleHistoryPage({ params }: Props) {
  const { topicSlug, articleSlug } = await params;

  const topic = await prisma.topic.findUnique({ where: { slug: topicSlug } });
  if (!topic) notFound();

  const article = await prisma.article.findFirst({
    where: { topicId: topic.id, slug: articleSlug, deletedAt: null },
    include: {
      revisions: {
        orderBy: { createdAt: "desc" },
        include: {
          author: { select: { name: true, email: true } },
        },
      },
    },
  });

  if (!article) notFound();

  return (
    <div className="wiki-content" style={{ maxWidth: 900 }}>
      <nav className="breadcrumb">
        <Link href="/wiki">Noosphere</Link>
        <span className="breadcrumb-sep">/</span>
        <Link href={`/wiki/${topic.slug}`}>{topic.name}</Link>
        <span className="breadcrumb-sep">/</span>
        <Link href={`/wiki/${topic.slug}/${article.slug}`}>{article.title}</Link>
        <span className="breadcrumb-sep">/</span>
        <span>History</span>
      </nav>

      <div className="page-toolbar">
        <div>
          <h1 style={{ margin: 0 }}>Revision History</h1>
          <p className="page-subtitle">{article.title} has {article.revisions.length} saved revision{article.revisions.length === 1 ? "" : "s"}.</p>
        </div>
        <Link href={`/wiki/${topic.slug}/${article.slug}`} className="btn btn-secondary btn-sm">Back to article</Link>
      </div>

      {article.revisions.length === 0 ? (
        <div className="empty-state">
          <h3>No revisions yet</h3>
          <p>Saved edits will appear here.</p>
        </div>
      ) : (
        <div className="revision-list">
          {article.revisions.map((revision, index) => (
            <section key={revision.id} className="revision-card">
              <div className="revision-card-header">
                <div>
                  <h2>Revision {article.revisions.length - index}</h2>
                  <div className="article-meta">
                    {new Date(revision.createdAt).toLocaleString()} · {revision.author?.name ?? revision.author?.email ?? "Unknown author"}
                  </div>
                </div>
              </div>
              <div className="revision-card-title">{revision.title}</div>
              <pre className="revision-content-preview">{revision.content.slice(0, 1200)}{revision.content.length > 1200 ? "\n..." : ""}</pre>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
