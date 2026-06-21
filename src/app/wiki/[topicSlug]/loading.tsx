/**
 * Loading state for the topic page.
 * Shows a lightweight skeleton matching the topic page layout.
 */
export default function TopicLoading() {
  return (
    <div className="wiki-content" aria-busy="true" aria-live="polite">
      <div className="route-loading">
        <div className="route-loading-spinner" aria-hidden />
        <p className="route-loading-text">Loading topic…</p>
      </div>
    </div>
  );
}
