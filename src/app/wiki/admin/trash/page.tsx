import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { RestoreArticleForm } from "@/components/wiki/RestoreArticleForm";
import { restoreArticleAction } from "./actions";

export const dynamic = "force-dynamic";

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
    <div className="wiki-content" style={{ maxWidth: 1000 }}>
      <nav className="breadcrumb">
        <Link href="/wiki">Noosphere</Link>
        <span className="breadcrumb-sep">/</span>
        <span>Trash</span>
      </nav>

      <div className="page-toolbar">
        <div>
          <h1 style={{ margin: 0 }}>Trash</h1>
          <p className="page-subtitle">Soft-deleted articles can be restored from here.</p>
        </div>
      </div>

      <section className="admin-card">
        <h2>Deleted Articles</h2>
        {articles.length === 0 ? (
          <div className="empty-state">
            <h3>Trash is empty</h3>
            <p>No soft-deleted articles are waiting for restore.</p>
          </div>
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
