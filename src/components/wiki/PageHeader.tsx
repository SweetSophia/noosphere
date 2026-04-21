import type { ReactNode } from "react";

interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  meta,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div className={["page-header", className].filter(Boolean).join(" ")}>
      <div className="page-header-main">
        <div className="page-header-copy">
          {eyebrow ? <p className="page-eyebrow">{eyebrow}</p> : null}
          <h1 className="page-header-title">{title}</h1>
          {description ? <div className="page-subtitle">{description}</div> : null}
        </div>
        {actions ? <div className="page-header-actions">{actions}</div> : null}
      </div>
      {meta ? <div className="page-header-meta">{meta}</div> : null}
    </div>
  );
}
