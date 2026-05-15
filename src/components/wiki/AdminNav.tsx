"use client";

const NAV_ITEMS = [
  { href: "/wiki/admin/keys", label: "API Keys", key: "keys" },
  { href: "/wiki/admin/scopes", label: "Restricted Scopes", key: "scopes" },
  { href: "/wiki/admin/topics", label: "Topics", key: "topics" },
  { href: "/wiki/admin/tags", label: "Tags", key: "tags" },
  { href: "/wiki/admin/settings", label: "Recall Settings", key: "settings" },
  { href: "/wiki/admin/trash", label: "Trash", key: "trash" },
];

export function AdminNav({ current }: { current: string }) {
  return (
    <nav className="admin-nav" aria-label="Admin sections">
      {NAV_ITEMS.map((item) => (
        <a
          key={item.key}
          href={item.href}
          className={`admin-nav-item${item.key === current ? " admin-nav-item-active" : ""}`}
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}
