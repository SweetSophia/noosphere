import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Breadcrumbs } from "@/components/wiki/Breadcrumbs";
import { PageHeader } from "@/components/wiki/PageHeader";
import { AdminNav } from "@/components/wiki/AdminNav";
import { resolveSyncConflictAction } from "./actions";
import { SYNC_CONFLICT_REVIEW_STATUSES, type SyncConflictReviewStatus } from "@/lib/markdown-sync/conflict-review";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Sync Conflicts",
  description: "Review archived markdown sync conflicts and record resolution decisions.",
};

const STATUS_LABELS: Record<SyncConflictReviewStatus, string> = {
  open: "Open",
  resolved: "Resolved",
  "ignored-once": "Ignored Once",
  "ignored-always": "Ignored Always",
};

function normalizeStatus(status: unknown): SyncConflictReviewStatus {
  return SYNC_CONFLICT_REVIEW_STATUSES.includes(status as SyncConflictReviewStatus)
    ? (status as SyncConflictReviewStatus)
    : "open";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function tagList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
}

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : date.toLocaleString();
}

export default async function SyncConflictsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    redirect("/wiki/login");
  }
  if (session.user.role !== "ADMIN") {
    redirect("/wiki");
  }

  const params = await searchParams;
  const status = normalizeStatus(params.status);

  const [reviews, counts] = await Promise.all([
    prisma.syncConflictReview.findMany({
      where: { status },
      include: {
        article: {
          select: {
            title: true,
            slug: true,
            topic: { select: { slug: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.syncConflictReview.groupBy({
      by: ["status"],
      _count: { status: true },
    }),
  ]);

  const countByStatus = new Map(counts.map((item) => [item.status, item._count.status]));

  return (
    <div className="wiki-content" style={{ maxWidth: 1120 }}>
      <Breadcrumbs
        items={[
          { label: "Noosphere", href: "/wiki" },
          { label: "Admin" },
          { label: "Sync Conflicts" },
        ]}
      />

      <PageHeader
        eyebrow="Admin Console"
        title="Sync Conflicts"
        description="Review archived markdown changes detected during sync and record the intended resolution."
      />

      <AdminNav current="sync-conflicts" />

      <div className="activity-filter-bar" aria-label="Filter sync conflicts by status">
        {SYNC_CONFLICT_REVIEW_STATUSES.map((item) => (
          <Link
            key={item}
            href={`/wiki/admin/sync-conflicts?status=${item}`}
            className={`filter-chip ${status === item ? "is-active" : ""}`}
          >
            {STATUS_LABELS[item]} <span className="filter-chip-count">({countByStatus.get(item) ?? 0})</span>
          </Link>
        ))}
      </div>

      {reviews.length === 0 ? (
        <div className="empty-state activity-empty-state">
          <h3>No {STATUS_LABELS[status].toLowerCase()} sync conflicts</h3>
          <p>Conflicts will appear here when sync archives a locally modified markdown file.</p>
        </div>
      ) : (
        <div className="sync-conflict-list">
          {reviews.map((review) => {
            const summary = asRecord(review.summary);
            const noosphere = asRecord(summary.noosphere);
            const markdown = asRecord(summary.markdown);
            const articleHref = review.article
              ? `/wiki/${[review.article.topic.slug, review.article.slug].join("/")}`
              : null;

            return (
              <article key={review.id} className="admin-card sync-conflict-card">
                <div className="sync-conflict-header">
                  <div>
                    <p className="page-eyebrow">{review.direction}</p>
                    <h2 className="section-title">{review.relativePath}</h2>
                    <div className="activity-meta">
                      <span className="activity-type-badge">{review.status}</span>
                      <time dateTime={review.createdAt.toISOString()}>{formatDate(review.createdAt)}</time>
                      {articleHref && (
                        <Link href={articleHref} className="activity-author-link">
                          Open article
                        </Link>
                      )}
                      <Link href={`/api/sync/conflicts/${review.id}/archive`} className="activity-author-link">
                        Archived markdown
                      </Link>
                    </div>
                  </div>
                </div>

                <div className="sync-conflict-diff-grid" aria-label="Conflict metadata comparison">
                  <ConflictSide
                    title="Noosphere"
                    fields={[
                      ["Title", stringValue(noosphere.title)],
                      ["Slug", stringValue(noosphere.slug)],
                      ["Topic", stringValue(noosphere.topic)],
                      ["Updated", formatDate(stringValue(noosphere.updatedAt))],
                      ["Status", stringValue(noosphere.status)],
                      ["Confidence", stringValue(noosphere.confidence)],
                      ["Tags", tagList(noosphere.tags).join(", ") || null],
                      ["Hash", stringValue(noosphere.contentHash)],
                    ]}
                  />
                  <ConflictSide
                    title="Markdown"
                    fields={[
                      ["Title", stringValue(markdown.title)],
                      ["Slug", stringValue(markdown.slug)],
                      ["Topic", stringValue(markdown.topic)],
                      ["Updated", formatDate(stringValue(markdown.updatedAt))],
                      ["Status", stringValue(markdown.status)],
                      ["Confidence", stringValue(markdown.confidence)],
                      ["Tags", tagList(markdown.tags).join(", ") || null],
                      ["Hash", stringValue(markdown.contentHash)],
                      ["Parse", stringValue(markdown.parseError) ?? "OK"],
                    ]}
                  />
                </div>

                {review.status === "open" && (
                  <>
                    <p className="sync-conflict-decision-note">
                      These actions record an audit decision only. They do not import markdown or rewrite vault
                      files yet.
                    </p>
                    <div className="sync-conflict-actions" aria-label="Record sync conflict decision">
                      <ConflictActionButton
                        label="Record: Keep Noosphere"
                        action="keep-noosphere"
                        conflictId={review.id}
                        returnStatus={status}
                      />
                      <ConflictActionButton
                        label="Record: Keep Markdown"
                        action="keep-markdown"
                        conflictId={review.id}
                        returnStatus={status}
                      />
                      <ConflictActionButton
                        label="Record: Resolved"
                        action="mark-resolved"
                        conflictId={review.id}
                        returnStatus={status}
                      />
                      <ConflictActionButton
                        label="Ignore Once"
                        action="ignore-once"
                        conflictId={review.id}
                        returnStatus={status}
                      />
                      <ConflictActionButton
                        label="Ignore Always"
                        action="ignore-always"
                        conflictId={review.id}
                        returnStatus={status}
                      />
                    </div>
                  </>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ConflictSide({ title, fields }: { title: string; fields: Array<[string, string | null]> }) {
  return (
    <section className="sync-conflict-side">
      <h3>{title}</h3>
      <dl>
        {fields.map(([label, value]) => (
          <div key={label} className="sync-conflict-field">
            <dt>{label}</dt>
            <dd>{value ?? "—"}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ConflictActionButton({
  label,
  action,
  conflictId,
  returnStatus,
}: {
  label: string;
  action: string;
  conflictId: string;
  returnStatus: SyncConflictReviewStatus;
}) {
  return (
    <form action={resolveSyncConflictAction}>
      <input type="hidden" name="conflictId" value={conflictId} />
      <input type="hidden" name="action" value={action} />
      <input type="hidden" name="returnStatus" value={returnStatus} />
      <button className="btn btn-secondary btn-sm" type="submit">
        {label}
      </button>
    </form>
  );
}
