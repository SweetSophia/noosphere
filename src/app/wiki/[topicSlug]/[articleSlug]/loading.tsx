/**
 * Loading state for the article page.
 * Shows a branded spinner while the article data is fetched.
 */
export default function ArticleLoading() {
  return (
    <div className="wiki-content" aria-busy="true" aria-live="polite">
      <div className="route-loading" role="status">
        <div className="route-loading-spinner" aria-hidden />
        <p className="route-loading-text">Loading article…</p>
      </div>
    </div>
  );
}
