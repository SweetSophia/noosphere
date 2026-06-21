/**
 * Wiki-wide loading state.
 * Shown by Next.js App Router while any segment under /wiki without its own
 * loading.tsx is streaming or fetching data.
 */
export default function WikiLoading() {
  return (
    <div className="wiki-content" aria-busy="true" aria-live="polite">
      <div className="route-loading">
        <div className="route-loading-spinner" aria-hidden />
        <p className="route-loading-text">Loading…</p>
      </div>
    </div>
  );
}
