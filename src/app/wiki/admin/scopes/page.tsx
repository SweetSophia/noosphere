import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Breadcrumbs } from "@/components/wiki/Breadcrumbs";
import { PageHeader } from "@/components/wiki/PageHeader";
import { EmptyState } from "@/components/wiki/EmptyState";
import { createScopeAction, deleteScopeAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Restricted Scopes",
  description: "Manage restricted access scope tags that control which articles an API key can read.",
};

export default async function ScopesPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    redirect("/wiki/login");
  }
  if (session.user.role !== "ADMIN") {
    redirect("/wiki");
  }

  const scopes = await prisma.restrictedScope.findMany({
    orderBy: [{ isSystem: "desc" }, { tag: "asc" }],
  });

  const systemScopes = scopes.filter((s) => s.isSystem);
  const customScopes = scopes.filter((s) => !s.isSystem);

  return (
    <div className="wiki-content">
      <Breadcrumbs
        items={[
          { label: "Noosphere", href: "/wiki" },
          { label: "Admin" },
          { label: "Restricted Scopes" },
        ]}
      />

      <PageHeader
        eyebrow="Admin Console"
        title="Restricted Scopes"
        description="Restricted scopes control which articles an API key can access. Articles tagged with a scope are only visible to keys that include that scope in their allowedScopes."
      />

      <section className="admin-card">
        <div className="section-header">
          <div className="section-header-copy">
            <p className="page-eyebrow">Registry</p>
            <h2 className="section-title">Create Scope</h2>
            <p className="section-subtitle">
              Create a custom scope tag. System scopes cannot be deleted. Articles using a scope must be updated before the scope can be removed.
            </p>
          </div>
        </div>
        <form action={createScopeAction} className="admin-form-grid">
          <div className="form-group">
            <label className="form-label" htmlFor="tag">
              Tag <span className="text-muted">(lowercase, hyphens allowed)</span>
            </label>
            <input
              id="tag"
              name="tag"
              type="text"
              className="form-input"
              placeholder="company-x"
              pattern="[a-z0-9-]+"
              maxLength={64}
              required
            />
          </div>
          <div className="form-group form-group-wide">
            <label className="form-label" htmlFor="description">
              Description <span className="text-muted">(optional)</span>
            </label>
            <input
              id="description"
              name="description"
              type="text"
              className="form-input"
              placeholder="Company X project material"
            />
          </div>
          <div className="admin-form-actions">
            <button type="submit" className="btn btn-primary">Create Scope</button>
          </div>
        </form>
      </section>

      {scopes.length === 0 ? (
        <EmptyState
          title="No scopes defined"
          description="Create a scope above to get started."
        />
      ) : (
        <>
          {systemScopes.length > 0 && (
            <section className="admin-card">
              <div className="section-header">
                <div className="section-header-copy">
                  <p className="page-eyebrow">System</p>
                  <h2 className="section-title">Built-in Scopes</h2>
                  <p className="section-subtitle">These scopes are locked and cannot be deleted.</p>
                </div>
              </div>
              <div className="table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Tag</th>
                      <th>Description</th>
                      <th>Articles</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {systemScopes.map((scope) => (
                      <tr key={scope.tag}>
                        <td>
                          <code className="scope-tag">{scope.tag}</code>
                        </td>
                        <td>{scope.description ?? <span className="text-muted">—</span>}</td>
                        <td>
                          <ScopeArticleCount tag={scope.tag} />
                        </td>
                        <td>
                          <span className="text-muted">System scope — cannot delete</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {customScopes.length > 0 && (
            <section className="admin-card">
              <div className="section-header">
                <div className="section-header-copy">
                  <p className="page-eyebrow">Custom</p>
                  <h2 className="section-title">Custom Scopes</h2>
                  <p className="section-subtitle">
                    These scopes were created by an admin and can be deleted if no articles use them.
                  </p>
                </div>
              </div>
              <div className="table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Tag</th>
                      <th>Description</th>
                      <th>Articles</th>
                      <th>Created</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {customScopes.map((scope) => (
                      <tr key={scope.tag}>
                        <td>
                          <code className="scope-tag">{scope.tag}</code>
                        </td>
                        <td>{scope.description ?? <span className="text-muted">—</span>}</td>
                        <td>
                          <ScopeArticleCount tag={scope.tag} />
                        </td>
                        <td>{new Date(scope.createdAt).toLocaleDateString()}</td>
                        <td>
                          <form action={deleteScopeAction}>
                            <input type="hidden" name="tag" value={scope.tag} />
                            <button type="submit" className="btn btn-secondary btn-sm">
                              Delete
                            </button>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

async function ScopeArticleCount({ tag }: { tag: string }) {
  const count = await prisma.article.count({
    where: { restrictedTags: { has: tag } },
  });
  return (
    <span className={count > 0 ? "count-badge count-badge-active" : "count-badge"}>
      {count}
    </span>
  );
}
