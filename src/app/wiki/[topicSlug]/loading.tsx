/**
 * Loading state for the topic page.
 * Shows a branded spinner while the topic data is fetched.
 */
export default function TopicLoading() {
  return (
    <div className="wiki-content" aria-busy="true" aria-live="polite">
      <div className="route-loading" role="status">
        <div className="route-loading-spinner" aria-hidden />
        <p className="route-loading-text">Loading topic…</p>
      </div>
    </div>
  );
}
