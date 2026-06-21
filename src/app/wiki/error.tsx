"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * Wiki-wide error boundary.
 * Catches unhandled errors thrown in any server component under /wiki.
 * Must be a client component per Next.js App Router requirements.
 */
export default function WikiError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface the error in the server console for debugging
    console.error("[Noosphere wiki error]", error);
  }, [error]);

  return (
    <div className="wiki-content">
      <div className="route-state route-state-error">
        <p className="route-state-eyebrow">Something went wrong</p>
        <h1 className="route-state-title">Unexpected error</h1>
        <p className="route-state-description">
          An error occurred while loading this page. You can try again, or navigate back to safety.
        </p>
        {error.digest ? (
          <p className="route-state-digest">Error ID: {error.digest}</p>
        ) : null}
        <div className="route-state-actions">
          <button type="button" onClick={reset} className="btn btn-primary btn-sm">
            Try again
          </button>
          <Link href="/wiki" className="btn btn-secondary btn-sm">
            Back to Noosphere
          </Link>
        </div>
      </div>
    </div>
  );
}
