import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { CopyButton } from "@/components/wiki/CopyButton";
import { createApiKeyAction, revokeApiKeyAction } from "./actions";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

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
  // Clear the flash cookie now that we've read it
  if (flashKey) {
    cookieStore.delete("api_key_flash");
  }

  const keys = await prisma.apiKey.findMany({
    orderBy: [{ revokedAt: "asc" }, { createdAt: "desc" }],
  });

  return (
    <div className="wiki-content" style={{ maxWidth: 1000 }}>
      <nav className="breadcrumb">
        <Link href="/wiki">Noosphere</Link>
        <span className="breadcrumb-sep">/</span>
        <span>API Keys</span>
      </nav>

      <div className="page-toolbar">
        <div>
          <h1 style={{ margin: 0 }}>API Keys</h1>
          <p className="page-subtitle">Create and revoke agent keys for Noosphere automation.</p>
        </div>
      </div>

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
        <h2>Create API Key</h2>
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
        <h2>Existing Keys</h2>
        {keys.length === 0 ? (
          <div className="empty-state">
            <h3>No API keys yet</h3>
            <p>Create one above for agents or external automation.</p>
          </div>
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
