import Link from "next/link";
import "./wiki.css";

export default function WikiLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="wiki-layout">
      <header className="wiki-header">
        <Link href="/wiki" className="wiki-logo">
          Noosphere
        </Link>

        <form action="/wiki/search" method="get" className="wiki-search-form">
          <input
            type="search"
            name="q"
            placeholder="Search articles, excerpts, tags..."
            className="wiki-search-input"
          />
          <button type="submit" className="btn btn-secondary btn-sm">
            Search
          </button>
        </form>

        <nav className="wiki-nav">
          <Link href="/wiki" className="nav-link">Browse</Link>
          <Link href="/wiki/login" className="nav-link">Sign In</Link>
        </nav>
      </header>
      <main className="wiki-main">{children}</main>
    </div>
  );
}
