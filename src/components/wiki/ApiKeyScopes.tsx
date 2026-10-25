export function ScopePicker({
  scopes,
  selected,
}: {
  scopes: { tag: string; description: string | null; isSystem: boolean }[];
  selected: string[];
}) {
  return (
    <div className="scope-picker">
      <label className="scope-checkbox-label">
        <input
          type="checkbox"
          name="scopes"
          value="*"
          defaultChecked={selected.includes("*")}
          className="scope-checkbox-input"
        />
        <span className="scope-checkbox-content">
          <strong>Full access (*)</strong>
          <span className="scope-checkbox-desc">
            Grants access to all restricted articles. Together with WRITE or ADMIN
            permission, allows shared taxonomy updates; deletion still requires ADMIN.
            Select only when this broader access is intended.
          </span>
        </span>
      </label>
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

export function ScopeBadges({ scopes }: { scopes: string[] }) {
  if (!scopes || scopes.length === 0) {
    return <span className="scope-badge scope-badge-none">Public articles only</span>;
  }
  return (
    <div className="scope-badge-row">
      {scopes.includes("*") && <span className="scope-badge">Full access (*)</span>}
      {scopes.filter((scope) => scope !== "*").map((s) => (
        <code key={s} className="scope-tag">{s}</code>
      ))}
    </div>
  );
}
