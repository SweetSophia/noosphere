import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Breadcrumbs } from "@/components/wiki/Breadcrumbs";
import { PageHeader } from "@/components/wiki/PageHeader";
import { AdminNav } from "@/components/wiki/AdminNav";
import { DeleteTagButton } from "@/components/wiki/DeleteTagButton";
import { createTagAction, renameTagAction, deleteTagAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Tags",
  description: "Create, rename, and delete article tags.",
};

export default async function TagsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/wiki/login");
  if (session.user.role !== "ADMIN") redirect("/wiki");

  const tags = await prisma.tag.findMany({
    include: { _count: { select: { articles: true } } },
    orderBy: { name: "asc" },
  });

  return (
    <div className="wiki-content">
      <Breadcrumbs
        items={[
          { label: "Noosphere", href: "/wiki" },
          { label: "Admin" },
          { label: "Tags" },
        ]}
      />

      <PageHeader
        eyebrow="Admin Console"
        title="Tags"
        description="Tags are cross-cutting labels for articles. They are created implicitly when used in articles, but you can also create and rename them here."
      />

      <AdminNav current="tags" />

      {/* ── Create tag ──────────────────────────────────────────── */}
      <section className="admin-card">
        <div className="section-header">
          <div className="section-header-copy">
            <p className="page-eyebrow">Create</p>
            <h2 className="section-title">New Tag</h2>
          </div>
        </div>
        <form action={createTagAction} className="admin-form-grid">
          <div className="form-group">
            <label className="form-label" htmlFor="name">Tag name</label>
            <input
              id="name"
              name="name"
              type="text"
              className="form-input"
              placeholder="python"
              maxLength={64}
              required
            />
          </div>
          <div className="admin-form-actions">
            <button type="submit" className="btn btn-primary">Create tag</button>
          </div>
        </form>
      </section>

      {/* ── Tag list ─────────────────────────────────────────────── */}
      <section className="admin-card">
        <div className="section-header">
          <div className="section-header-copy">
            <p className="page-eyebrow">Registry</p>
            <h2 className="section-title">All Tags</h2>
            <p className="section-subtitle">
              {tags.length === 0
                ? "No tags yet."
                : `${tags.length} tag${tags.length !== 1 ? "s" : ""} total.`}
            </p>
          </div>
        </div>

        {tags.length === 0 ? (
          <p className="text-muted">No tags yet. Create one above, or save an article with a new tag name.</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Slug</th>
                <th>Articles</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {tags.map((tag) => (
                <tr key={tag.id}>
                  <td><strong>{tag.name}</strong></td>
                  <td><code>{tag.slug}</code></td>
                  <td><strong>{tag._count.articles}</strong></td>
                  <td>
                    <div className="topic-actions">
                      <details className="scope-edit-dropdown">
                        <summary className="btn btn-secondary btn-sm">Rename</summary>
                        <div className="scope-edit-panel">
                          <p className="scope-edit-title">Rename: {tag.name}</p>
                          <form action={renameTagAction} className="scope-edit-form">
                            <input type="hidden" name="id" value={tag.id} />
                            <div className="form-group">
                              <label className="form-label">New name</label>
                              <input
                                name="name"
                                type="text"
                                className="form-input"
                                defaultValue={tag.name}
                                maxLength={64}
                                required
                              />
                            </div>
                            <div className="scope-edit-actions">
                              <button type="submit" className="btn btn-primary btn-sm">Save</button>
                            </div>
                          </form>
                        </div>
                      </details>
                      <DeleteTagButton
                        tagId={tag.id}
                        tagName={tag.name}
                        articleCount={tag._count.articles}
                        deleteAction={deleteTagAction}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
