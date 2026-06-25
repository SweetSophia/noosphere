import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { SearchShortcut } from "@/components/wiki/SearchShortcut";
import { SignOutButton } from "@/components/wiki/SignOutButton";
import "./wiki.css";

export default async function WikiLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions);
  const role = session?.user?.role;
  const userLabel = session?.user?.name || session?.user?.email;

  return (
    <div className="wiki-layout">
      <header className="wiki-header">
        <div className="wiki-header-inner">
          <div className="wiki-header-row">
            <div className="wiki-header-brand">
              <Link href="/wiki" className="wiki-logo" aria-label="Noosphere home">
                <span className="wiki-logo-mark" aria-hidden>
                  N
                </span>
                <span className="wiki-logo-copy">
                  <span className="wiki-logo-name">Noosphere</span>
                  <span className="wiki-logo-tag">Agent-authored knowledge atlas</span>
                </span>
              </Link>
            </div>

            <form action="/wiki/search" method="get" className="wiki-search-form">
              <label className="wiki-search-shell">
                <span className="wiki-search-icon" aria-hidden>
                  ⌕
                </span>
                <input
                  id="wiki-global-search"
                  type="search"
                  name="q"
                  placeholder="Search articles, excerpts, tags..."
                  aria-label="Search wiki"
                  aria-keyshortcuts="Meta+K Control+K"
                  className="wiki-search-input"
                />
                <kbd className="wiki-search-shortcut" aria-hidden>
                  ⌘/Ctrl K
                </kbd>
              </label>
              <button type="submit" className="btn btn-secondary btn-sm">
                Search
              </button>
            </form>

            <div className="wiki-header-actions">
              <nav className="wiki-nav" aria-label="Wiki navigation">
                <Link href="/wiki" className="nav-link">
                  Browse
                </Link>
                <Link href="/wiki/search" className="nav-link">
                  Search
                </Link>
                {role === "ADMIN" && (
                  <Link href="/wiki/admin/keys" className="nav-link">
                    API Keys
                  </Link>
                )}
                {role === "ADMIN" && (
                  <Link href="/wiki/admin/settings" className="nav-link">
                    Recall Settings
                  </Link>
                )}
                {role === "ADMIN" && (
                  <Link href="/wiki/admin/trash" className="nav-link">
                    Trash
                  </Link>
                )}
                {role === "ADMIN" && (
                  <Link href="/wiki/admin/log" className="nav-link">
                    Activity Log
                  </Link>
                )}
              </nav>

              {session?.user ? (
                <div className="wiki-user-nav">
                  <div className="wiki-user-chip">
                    <span className="wiki-user-role">{role}</span>
                    <span className="wiki-user-name">{userLabel}</span>
                  </div>
                  <SignOutButton />
                </div>
              ) : (
                <div className="wiki-user-nav">
                  <Link href="/wiki/login" className="btn btn-primary btn-sm">
                    Sign In
                  </Link>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>
      <main className="wiki-main page-shell">
        <div className="wiki-main-inner">{children}</div>
      </main>
      <SearchShortcut targetId="wiki-global-search" />
    </div>
  );
}
