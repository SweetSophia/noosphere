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
        <nav className="wiki-nav">
          <Link href="/wiki" className="nav-link">Browse</Link>
          <Link href="/wiki/login" className="nav-link">Sign In</Link>
        </nav>
      </header>
      <main className="wiki-main">{children}</main>
    </div>
  );
}
