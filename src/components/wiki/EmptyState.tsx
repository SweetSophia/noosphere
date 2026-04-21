import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  description: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-state-inner">
        <p className="empty-state-kicker">Nothing here yet</p>
        <h3>{title}</h3>
        <p>{description}</p>
        {action ? <div className="empty-state-actions">{action}</div> : null}
      </div>
    </div>
  );
}
