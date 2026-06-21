import Link from "next/link";

/**
 * Wiki-wide 404.
 * Triggered by notFound() calls in topic/article pages and by unknown /wiki/* routes.
 */
export default function WikiNotFound() {
  return (
    <div className="wiki-content">
      <div className="route-state">
        <p className="route-state-eyebrow">404</p>
        <h1 className="route-state-title">Page not found</h1>
        <p className="route-state-description">
          The topic or article you&apos;re looking for may have been moved, renamed, or deleted.
        </p>
        <div className="route-state-actions">
          <Link href="/wiki" className="btn btn-primary btn-sm">
            Back to Noosphere
          </Link>
          <Link href="/wiki/search" className="btn btn-secondary btn-sm">
            Search articles
          </Link>
        </div>
      </div>
    </div>
  );
}
