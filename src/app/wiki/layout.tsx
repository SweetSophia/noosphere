import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { SignOutButton } from "@/components/wiki/SignOutButton";
import "./wiki.css";

export default async function WikiLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions);
  const role = session?.user?.role;

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
          {role === "ADMIN" && <Link href="/wiki/admin/keys" className="nav-link">API Keys</Link>}
          {session?.user ? (
            <div className="wiki-user-nav">
              <span className="wiki-user-name">
                {session.user.name || session.user.email} ({role})
              </span>
              <SignOutButton />
            </div>
          ) : (
            <Link href="/wiki/login" className="nav-link">Sign In</Link>
          )}
        </nav>
      </header>
      <main className="wiki-main">{children}</main>
    </div>
  );
}
