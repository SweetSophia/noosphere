import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Breadcrumbs } from "@/components/wiki/Breadcrumbs";
import { PageHeader } from "@/components/wiki/PageHeader";
import { EmptyState } from "@/components/wiki/EmptyState";
import { CopyButton } from "@/components/wiki/CopyButton";
import { createApiKeyAction, revokeApiKeyAction, rotateApiKeyAction, deleteApiKeyAction, updateApiKeyScopesAction } from "./actions";
import { AdminNav } from "@/components/wiki/AdminNav";
import { KeyActionButtons } from "@/components/wiki/KeyActionButtons";
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

  const [keys, scopes] = await Promise.all([
    prisma.apiKey.findMany({
      orderBy: [{ revokedAt: "asc" }, { createdAt: "desc" }],
    }),
    prisma.restrictedScope.findMany({
      orderBy: [{ isSystem: "desc" }, { tag: "asc" }],
    }),
  ]);

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
        description="Create and revoke agent keys. Keys control which articles an agent can read and write based on their allowed scopes."
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

      <AdminNav current="keys" />

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
          <div className="form-group form-group-wide">
            <label className="form-label">
              Allowed Scopes <span className="text-muted">(optional)</span>
            </label>
            <p className="form-hint">
              Leave all unchecked for unrestricted access. Scopes restrict which articles this key can read.
            </p>
            <ScopePicker scopes={scopes} selected={[]} />
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
          <div className="admin-table-wrap api-key-table-wrap">
            <table className="admin-table api-key-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Prefix</th>
                  <th>Permissions</th>
                  <th>Scopes</th>
                  <th>Created</th>
                  <th>Last Used</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id}>
                    <td data-label="Name">{key.name}</td>
                    <td data-label="Prefix"><code>{key.keyPrefix}…</code></td>
                    <td data-label="Permissions">{key.permissions}</td>
                    <td data-label="Scopes">
                      <ScopeBadges scopes={key.allowedScopes} />
                    </td>
                    <td data-label="Created">{new Date(key.createdAt).toLocaleDateString()}</td>
                    <td data-label="Last Used">{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : "Never"}</td>
                    <td data-label="Status">{key.revokedAt ? "Revoked" : "Active"}</td>
                    <td data-label="Actions" className="api-key-action-cell">
                      <div className="api-key-actions">
                        {!key.revokedAt && (
                          <details className="scope-edit-dropdown">
                            <summary className="btn btn-secondary btn-sm">Edit Scopes</summary>
                            <div className="scope-edit-panel">
                              <p className="scope-edit-title">
                                Edit scopes for <strong>{key.name}</strong>
                              </p>
                              <form action={updateApiKeyScopesAction} className="scope-edit-form">
                                <input type="hidden" name="id" value={key.id} />
                                <ScopePicker scopes={scopes} selected={key.allowedScopes} />
                                <div className="scope-edit-actions">
                                  <button type="submit" className="btn btn-primary btn-sm">
                                    Save
                                  </button>
                                </div>
                              </form>
                            </div>
                          </details>
                        )}
                        <KeyActionButtons
                          keyId={key.id}
                          keyName={key.name}
                          isRevoked={!!key.revokedAt}
                          revokeAction={revokeApiKeyAction}
                          rotateAction={rotateApiKeyAction}
                          deleteAction={deleteApiKeyAction}
                        />
                      </div>
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

function ScopePicker({
  scopes,
  selected,
}: {
  scopes: { tag: string; description: string | null; isSystem: boolean }[];
  selected: string[];
}) {
  return (
    <div className="scope-picker">
      {scopes.length === 0 ? (
        <p className="text-muted">No scopes defined yet. Create one at /wiki/admin/scopes.</p>
      ) : (
        <div className="scope-checkboxes">
          {scopes.map((scope) => (
            <label key={scope.tag} className="scope-checkbox-label">
              <input
                type="checkbox"
                name="scopes"
                value={scope.tag}
                defaultChecked={selected.includes(scope.tag)}
                className="scope-checkbox-input"
              />
              <span className="scope-checkbox-content">
                <code className="scope-tag">{scope.tag}</code>
                {scope.description && (
                  <span className="scope-checkbox-desc">{scope.description}</span>
                )}
                {scope.isSystem && (
                  <span className="scope-system-badge">system</span>
                )}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function ScopeBadges({ scopes }: { scopes: string[] }) {
  if (!scopes || scopes.length === 0) {
    return <span className="scope-badge scope-badge-none">Unrestricted</span>;
  }
  return (
    <div className="scope-badge-row">
      {scopes.map((s) => (
        <code key={s} className="scope-tag">{s}</code>
      ))}
    </div>
  );
}
