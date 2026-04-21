import type { CSSProperties } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const metadata = {
  title: "Activity Log",
  description: "Review recent ingest, edit, delete, and maintenance activity across Noosphere.",
};

const TYPE_COLORS: Record<string, string> = {
  ingest: "#22c55e",
  create: "#3b82f6",
  update: "#f59e0b",
  delete: "#ef4444",
  lint: "#8b5cf6",
};

function buildLogHref(type?: string, author?: string) {
  const search = new URLSearchParams();

  if (type) search.set("type", type);
  if (author) search.set("author", author);

  const query = search.toString();
  return query ? `/wiki/admin/log?${query}` : "/wiki/admin/log";
}

export default async function ActivityLogPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; author?: string }>;
}) {
  // Page-level auth check
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    redirect("/wiki/login");
  }
  if (session.user.role !== "ADMIN") {
    redirect("/wiki");
  }

  const params = await searchParams;

  const where: Record<string, unknown> = {};
  if (params.type) where.type = params.type;
  if (params.author) where.authorName = { equals: params.author, mode: "insensitive" };

  const [entries, typeCounts] = await Promise.all([
    prisma.activityLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.activityLog.groupBy({
      by: ["type"],
      _count: { type: true },
      orderBy: { _count: { type: "desc" } },
    }),
  ]);

  const totalCount = typeCounts.reduce((sum, item) => sum + item._count.type, 0);

  return (
    <div className="wiki-content" style={{ maxWidth: 1040 }}>
      <div className="page-toolbar">
        <div>
          <p className="page-eyebrow">Admin Console</p>
          <h1>Activity Log</h1>
          <p className="page-subtitle">
            A rolling audit trail of ingests, edits, deletions, and maintenance events across the wiki.
          </p>
        </div>

        <div className="page-actions">
          <Link href="/wiki" className="btn btn-secondary">
            Back to Wiki
          </Link>
        </div>
      </div>

      <div className="activity-filter-bar" aria-label="Filter activity by type">
        <Link
          href={buildLogHref(undefined, params.author)}
          className={`filter-chip ${!params.type ? "is-active" : ""}`}
        >
          All <span className="filter-chip-count">({totalCount})</span>
        </Link>

        {typeCounts.map((tc) => (
          <Link
            key={tc.type}
            href={buildLogHref(tc.type, params.author)}
            className={`filter-chip ${params.type === tc.type ? "is-active" : ""}`}
            style={
              params.type === tc.type
                ? ({ background: TYPE_COLORS[tc.type] || "var(--accent-color)", borderColor: TYPE_COLORS[tc.type] || "var(--accent-color)" } as CSSProperties)
                : undefined
            }
          >
            {tc.type} <span className="filter-chip-count">({tc._count.type})</span>
          </Link>
        ))}

        {params.author && (
          <Link href={buildLogHref(params.type)} className="filter-chip is-secondary">
            Author: {params.author} ×
          </Link>
        )}
      </div>

      {entries.length === 0 ? (
        <div className="empty-state activity-empty-state">
          <h3>No activity recorded</h3>
          <p>Try another filter or wait for the next wiki event to arrive.</p>
        </div>
      ) : (
        <div className="activity-timeline">
          {entries.map((entry) => {
            const createdAt = new Date(entry.createdAt);
            const entryStyle = {
              "--activity-color": TYPE_COLORS[entry.type] || "var(--accent-color)",
            } as CSSProperties;

            return (
              <article key={entry.id} className="activity-entry" style={entryStyle}>
                <div className="activity-dot" aria-hidden />
                <div className="activity-content">
                  <div className="activity-header">
                    <div>
                      <h2 className="activity-title">{entry.title}</h2>
                      <div className="activity-meta">
                        <span className="activity-type-badge">{entry.type}</span>
                        {entry.authorName && (
                          <Link
                            href={buildLogHref(params.type, entry.authorName)}
                            className="activity-author-link"
                          >
                            by {entry.authorName}
                          </Link>
                        )}
                        <time className="activity-timestamp" dateTime={createdAt.toISOString()}>
                          {createdAt.toLocaleString()}
                        </time>
                      </div>
                    </div>
                  </div>

                  {entry.sourceUrl && (
                    <a href={entry.sourceUrl} target="_blank" rel="noopener noreferrer" className="activity-source-link">
                      <span>Source ↗</span>
                      <span className="activity-source-url">{entry.sourceUrl}</span>
                    </a>
                  )}

                  {entry.details && typeof entry.details === "object" && (
                    <div className="activity-details">
                      {Object.entries(entry.details as Record<string, unknown>).map(([key, value]) => (
                        <span key={key} className="activity-detail-tag">
                          {key}: {String(value)}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
