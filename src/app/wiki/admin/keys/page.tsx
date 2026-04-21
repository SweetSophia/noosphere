import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Breadcrumbs } from "@/components/wiki/Breadcrumbs";
import { PageHeader } from "@/components/wiki/PageHeader";
import { EmptyState } from "@/components/wiki/EmptyState";
import { CopyButton } from "@/components/wiki/CopyButton";
import { createApiKeyAction, revokeApiKeyAction } from "./actions";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "API Keys",
  description: "Create and revoke agent keys for Noosphere automation.",
};

interface Props {
  searchParams: Promise<{ flash?: string; name?: string }>;
}

export default async function ApiKeysPage({ searchParams }: Props) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    redirect("/wiki/login");
  }
  if (session.user.role !== "ADMIN") {
    redirect("/wiki");
  }

  const params = await searchParams;
  const cookieStore = await cookies();
  const flashKey = cookieStore.get("api_key_flash")?.value ?? null;

  const keys = await prisma.apiKey.findMany({
    orderBy: [{ revokedAt: "asc" }, { createdAt: "desc" }],
  });

  const activeKeys = keys.filter((k) => !k.revokedAt);
  const revokedKeys = keys.filter((k) => k.revokedAt);

  return (
    <div className="wiki-content">
      <Breadcrumbs
        items={[
          { label: "Noosphere", href: "/wiki" },
          { label: "API Keys" },
        ]}
      />

      <PageHeader
        eyebrow="Admin Console"
        title="API Keys"
        description="Create and revoke agent keys for Noosphere automation. Keys are stored as SHA-256 hashes and can only be shown once at creation time."
        meta={
          <div className="page-meta-pills">
            <span className="page-meta-pill">
              <strong>{activeKeys.length}</strong>
              <span>active key{activeKeys.length !== 1 ? "s" : ""}</span>
            </span>
            <span className="page-meta-pill">
              <strong>{revokedKeys.length}</strong>
              <span>revoked</span>
            </span>
          </div>
        }
      />

      {params.flash && flashKey && (
        <div className="alert alert-success">
          <strong>New key created for {params.name || "agent"}.</strong>
          <div className="secret-box-row">
            <div className="secret-box">{flashKey}</div>
            <CopyButton text={flashKey} label="Copy key" copiedLabel="Key copied" />
          </div>
          <p className="secret-hint">Save it now. The raw key is only shown once.</p>
        </div>
      )}

      <section className="admin-card">
        <div className="section-header">
          <div className="section-header-copy">
            <p className="page-eyebrow">Provisioning</p>
            <h2 className="section-title">Create API Key</h2>
          </div>
        </div>
        <form action={createApiKeyAction} className="admin-form-grid">
          <div className="form-group">
            <label className="form-label" htmlFor="name">Name</label>
            <input id="name" name="name" type="text" className="form-input" placeholder="Cylena Agent" required />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="permissions">Permissions</label>
            <select id="permissions" name="permissions" className="form-select" defaultValue="WRITE">
              <option value="READ">READ</option>
              <option value="WRITE">WRITE</option>
              <option value="ADMIN">ADMIN</option>
            </select>
          </div>
          <div className="admin-form-actions">
            <button type="submit" className="btn btn-primary">Create Key</button>
          </div>
        </form>
      </section>

      <section className="admin-card">
        <div className="section-header">
          <div className="section-header-copy">
            <p className="page-eyebrow">Registry</p>
            <h2 className="section-title">Existing Keys</h2>
          </div>
        </div>
        {keys.length === 0 ? (
          <EmptyState title="No API keys yet" description="Create one above for agents or external automation." />
        ) : (
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Prefix</th>
                  <th>Permissions</th>
                  <th>Created</th>
                  <th>Last Used</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id}>
                    <td>{key.name}</td>
                    <td><code>{key.keyPrefix}...</code></td>
                    <td>{key.permissions}</td>
                    <td>{new Date(key.createdAt).toLocaleString()}</td>
                    <td>{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "Never"}</td>
                    <td>{key.revokedAt ? "Revoked" : "Active"}</td>
                    <td>
                      {key.revokedAt ? (
                        <span className="text-muted">No actions</span>
                      ) : (
                        <form action={revokeApiKeyAction}>
                          <input type="hidden" name="id" value={key.id} />
                          <button type="submit" className="btn btn-secondary btn-sm">Revoke</button>
                        </form>
                      )}
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
