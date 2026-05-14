interface Scope {
  tag: string;
  description: string | null;
  isSystem: boolean;
}

interface Props {
  scopes: Scope[];
  selected: string[];
  name?: string;
}

export function RestrictedTagPicker({ scopes, selected, name = "restrictedTags" }: Props) {
  if (scopes.length === 0) {
    return null;
  }

  return (
    <div className="form-group">
      <label className="form-label">
        <span className="restricted-label">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
          Restricted Access
        </span>
        <span className="text-muted text-sm"> (optional)</span>
      </label>
      <p className="form-hint">
        Restrict this article to agents with matching scope tags. Leave unchecked for full access.
      </p>
      <div className="scope-picker">
        <div className="scope-checkboxes">
          {scopes.map((scope) => (
            <label key={scope.tag} className="scope-checkbox-label">
              <input
                type="checkbox"
                name={name}
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
      </div>
    </div>
  );
}
