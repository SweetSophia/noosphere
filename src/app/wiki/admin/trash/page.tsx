import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Breadcrumbs } from "@/components/wiki/Breadcrumbs";
import { PageHeader } from "@/components/wiki/PageHeader";
import { EmptyState } from "@/components/wiki/EmptyState";
import { RestoreArticleForm } from "@/components/wiki/RestoreArticleForm";
import { restoreArticleAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Trash",
  description: "Manage soft-deleted articles. Restore or permanently remove them.",
};

export default async function TrashPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/wiki/login");
  if (session.user.role !== "ADMIN") redirect("/wiki");

  const articles = await prisma.article.findMany({
    where: { deletedAt: { not: null } },
    include: {
      topic: true,
      author: { select: { name: true } },
    },
    orderBy: { deletedAt: "desc" },
  });

  return (
    <div className="wiki-content">
      <Breadcrumbs
        items={[
          { label: "Noosphere", href: "/wiki" },
          { label: "Trash" },
        ]}
      />

      <PageHeader
        eyebrow="Admin Console"
        title="Trash"
        description="Soft-deleted articles can be restored from here. Articles remain in trash until explicitly restored."
        meta={
          <div className="page-meta-pills">
            <span className="page-meta-pill">
              <strong>{articles.length}</strong>
              <span>deleted article{articles.length !== 1 ? "s" : ""}</span>
            </span>
          </div>
        }
      />

      <section className="admin-card">
        {articles.length === 0 ? (
          <EmptyState title="Trash is empty" description="No soft-deleted articles are waiting for restore." />
        ) : (
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Topic</th>
                  <th>Author</th>
                  <th>Deleted</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {articles.map((article) => (
                  <tr key={article.id}>
                    <td>
                      <div>{article.title}</div>
                      <div className="text-muted"><code>{article.slug}</code></div>
                    </td>
                    <td>{article.topic.name}</td>
                    <td>{article.author?.name ?? article.authorName ?? "Unknown"}</td>
                    <td>{article.deletedAt ? new Date(article.deletedAt).toLocaleString() : "-"}</td>
                    <td>
                      <RestoreArticleForm action={restoreArticleAction} articleId={article.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
