import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const metadata = {
  title: "Activity Log — Noosphere",
};

const TYPE_COLORS: Record<string, string> = {
  ingest: "#22c55e",
  create: "#3b82f6",
  update: "#f59e0b",
  delete: "#ef4444",
  lint: "#8b5cf6",
};

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

  return (
    <div className="wiki-container">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <h1>📋 Activity Log</h1>
        <Link href="/wiki" className="btn">← Back to Wiki</Link>
      </div>

      {/* Filter bar */}
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1.5rem" }}>
        <Link
          href="/wiki/admin/log"
          className="btn"
          style={!params.type ? { background: "var(--primary)", color: "#fff" } : {}}
        >
          All ({typeCounts.reduce((sum, t) => sum + t._count.type, 0)})
        </Link>
        {typeCounts.map((tc) => (
          <Link
            key={tc.type}
            href={`/wiki/admin/log?type=${tc.type}`}
            className="btn"
            style={params.type === tc.type ? { background: TYPE_COLORS[tc.type] || "var(--primary)", color: "#fff" } : {}}
          >
            {tc.type} ({tc._count.type})
          </Link>
        ))}
      </div>

      {/* Timeline */}
      {entries.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>No activity recorded yet.</p>
      ) : (
        <div className="activity-timeline">
          {entries.map((entry) => (
            <div key={entry.id} className="activity-entry">
              <div className="activity-dot" style={{ background: TYPE_COLORS[entry.type] || "var(--muted)" }} />
              <div className="activity-content">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" }}>
                  <span className="activity-title">{entry.title}</span>
                  <span className="activity-meta">
                    <span className="activity-type-badge" style={{ background: TYPE_COLORS[entry.type] || "var(--muted)" }}>
                      {entry.type}
                    </span>
                    {entry.authorName && <span> by {entry.authorName}</span>}
                    <span style={{ color: "var(--muted)", fontSize: "0.85em" }}>
                      {" "}{new Date(entry.createdAt).toLocaleString()}
                    </span>
                  </span>
                </div>
                {entry.sourceUrl && (
                  <a href={entry.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: "0.85em", color: "var(--primary)" }}>
                    🔗 {entry.sourceUrl}
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
