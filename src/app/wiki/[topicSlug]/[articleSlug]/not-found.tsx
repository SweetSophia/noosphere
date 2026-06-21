import Link from "next/link";

/**
 * Article-specific 404.
 * Gives a more targeted message than the wiki-level not-found.
 */
export default function ArticleNotFound() {
  return (
    <div className="wiki-content">
      <div className="route-state">
        <p className="route-state-eyebrow">404</p>
        <h1 className="route-state-title">Article not found</h1>
        <p className="route-state-description">
          This article may have been moved, renamed, or deleted. Try searching for it or browse the topic.
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
