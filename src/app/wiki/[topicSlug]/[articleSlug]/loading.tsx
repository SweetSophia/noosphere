/**
 * Loading state for the article page.
 * Shows a lightweight skeleton matching the article page layout.
 */
export default function ArticleLoading() {
  return (
    <div className="wiki-content" aria-busy="true" aria-live="polite">
      <div className="route-loading">
        <div className="route-loading-spinner" aria-hidden />
        <p className="route-loading-text">Loading article…</p>
      </div>
    </div>
  );
}
