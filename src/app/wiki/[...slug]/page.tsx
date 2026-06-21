import { notFound } from "next/navigation";

/**
 * Routes unmatched nested /wiki/* URLs through the wiki-styled not-found UI
 * instead of falling back to the app-level/default 404.
 */
export default function UnknownWikiRoutePage() {
  notFound();
}
