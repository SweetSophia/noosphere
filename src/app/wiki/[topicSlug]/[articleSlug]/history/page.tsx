export const dynamic = "force-dynamic";
import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Breadcrumbs } from "@/components/wiki/Breadcrumbs";
import { PageHeader } from "@/components/wiki/PageHeader";
import { EmptyState } from "@/components/wiki/EmptyState";

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
    <div className="wiki-content">
      <Breadcrumbs
        items={[
          { label: "Noosphere", href: "/wiki" },
          { label: topic.name, href: `/wiki/${topic.slug}` },
          { label: article.title, href: `/wiki/${topic.slug}/${article.slug}` },
          { label: "History" },
        ]}
      />

      <PageHeader
        eyebrow="Revision trail"
        title="Revision History"
        description={`${article.title} has ${article.revisions.length} saved revision${article.revisions.length === 1 ? "" : "s"}. Each revision captures title and content changes.`}
        actions={
          <Link href={`/wiki/${topic.slug}/${article.slug}`} className="btn btn-secondary btn-sm">
            Back to article
          </Link>
        }
        meta={
          <div className="page-meta-pills">
            <span className="page-meta-pill">
              <strong>{article.revisions.length}</strong>
              <span>revisions</span>
            </span>
            <span className="page-meta-pill">
              <strong>{topic.name}</strong>
              <span>topic</span>
            </span>
          </div>
        }
      />

      {article.revisions.length === 0 ? (
        <EmptyState title="No revisions yet" description="Saved edits will appear here as numbered revisions." />
      ) : (
        <div className="revision-list">
          {article.revisions.map((revision, index) => (
            <section key={revision.id} className="revision-card">
              <div className="revision-card-header">
                <div>
                  <p className="page-eyebrow">Revision {article.revisions.length - index}</p>
                  <h2>Revision {article.revisions.length - index}</h2>
                  <div className="article-meta">
                    {new Date(revision.createdAt).toLocaleString()} &middot; {revision.author?.name ?? revision.author?.email ?? "Unknown author"}
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
