import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Breadcrumbs } from "@/components/wiki/Breadcrumbs";
import { PageHeader } from "@/components/wiki/PageHeader";
import { AdminNav } from "@/components/wiki/AdminNav";
import { createTopicAction, updateTopicAction, deleteTopicAction } from "./actions";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Topics",
  description: "Create and manage topic categories and subtopics.",
};

interface TopicNode {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  parentId: string | null;
  _count: { articles: number };
  children: TopicNode[];
}

function buildTree(topics: Omit<TopicNode, "children">[]): TopicNode[] {
  const map = new Map<string, TopicNode>();
  const roots: TopicNode[] = [];

  for (const t of topics) {
    map.set(t.id, { ...t, children: [] });
  }
  for (const t of topics) {
    const node = map.get(t.id)!;
    if (t.parentId && map.has(t.parentId)) {
      map.get(t.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

async function getTopics(): Promise<{ roots: TopicNode[]; allTopics: Omit<TopicNode, "children">[] }> {
  const topics = await prisma.topic.findMany({
    include: { _count: { select: { articles: true } } },
    orderBy: { name: "asc" },
  });
  return { roots: buildTree(topics), allTopics: topics };
}

export default async function TopicsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/wiki/login");
  if (session.user.role !== "ADMIN") redirect("/wiki");

  const cookieStore = await cookies();
  const flash = cookieStore.get("flash")?.value ?? null;

  const { roots, allTopics } = await getTopics();

  return (
    <div className="wiki-content">
      <Breadcrumbs
        items={[
          { label: "Noosphere", href: "/wiki" },
          { label: "Admin" },
          { label: "Topics" },
        ]}
      />

      <PageHeader
        eyebrow="Admin Console"
        title="Topics"
        description="Organize the wiki with topics and subtopics. Topics with articles or subtopics cannot be deleted."
      />

      {flash && (
        <div className="alert alert-success" role="status">
          {decodeURIComponent(flash).replace(/\+/g, " ")}
        </div>
      )}

      <AdminNav current="topics" />

      {/* ── Create topic form ───────────────────────────────────── */}
      <section className="admin-card">
        <div className="section-header">
          <div className="section-header-copy">
            <p className="page-eyebrow">Create</p>
            <h2 className="section-title">New Topic</h2>
          </div>
        </div>
        <form action={createTopicAction} className="admin-form-grid">
          <div className="form-group">
            <label className="form-label" htmlFor="name">Name</label>
            <input
              id="name"
              name="name"
              type="text"
              className="form-input"
              placeholder="Engineering"
              maxLength={100}
              required
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="slug">
              Slug <span className="text-muted">(auto-derived if blank)</span>
            </label>
            <input
              id="slug"
              name="slug"
              type="text"
              className="form-input"
              placeholder="engineering"
              pattern="[a-z0-9-]+"
            />
          </div>
          <div className="form-group form-group-wide">
            <label className="form-label" htmlFor="parentId">
              Parent topic <span className="text-muted">(optional — leave blank for top-level)</span>
            </label>
            <select id="parentId" name="parentId" className="form-input">
              <option value="">— Top-level topic —</option>
              {allTopics.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div className="form-group form-group-wide">
            <label className="form-label" htmlFor="description">Description <span className="text-muted">(optional)</span></label>
            <input
              id="description"
              name="description"
              type="text"
              className="form-input"
              placeholder="All engineering-related articles live here."
              maxLength={255}
            />
          </div>
          <div className="admin-form-actions">
            <button type="submit" className="btn btn-primary">Create topic</button>
          </div>
        </form>
      </section>

      {/* ── Topic list ─────────────────────────────────────────── */}
      <TopicTree
        roots={roots}
        allTopics={allTopics}
      />
    </div>
  );
}

function TopicTree({
  roots,
  allTopics,
}: {
  roots: TopicNode[];
  allTopics: Omit<TopicNode, "children">[];
}) {
  if (roots.length === 0) {
    return (
      <section className="admin-card">
        <p className="text-muted">No topics yet. Create one above.</p>
      </section>
    );
  }

  return (
    <section className="admin-card">
      <div className="section-header">
        <div className="section-header-copy">
          <p className="page-eyebrow">Registry</p>
          <h2 className="section-title">All Topics</h2>
        </div>
      </div>
      <table className="admin-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Slug</th>
            <th>Parent</th>
            <th>Articles</th>
            <th>Description</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {roots.map((topic) => (
            <TopicRow key={topic.id} topic={topic} allTopics={allTopics} depth={0} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function TopicRow({
  topic,
  allTopics,
  depth,
}: {
  topic: TopicNode;
  allTopics: Omit<TopicNode, "children">[];
  depth: number;
}) {
  const parent = topic.parentId
    ? allTopics.find((t) => t.id === topic.parentId)
    : null;

  return (
    <>
      <tr>
        <td style={{ paddingLeft: `${depth * 24 + 12}px` }}>
          <span style={{ opacity: depth > 0 ? 0.6 : 1 }}>
            {topic.name}
          </span>
        </td>
        <td><code>{topic.slug}</code></td>
        <td>{parent ? <span className="text-muted">{parent.name}</span> : <span className="text-muted">—</span>}</td>
        <td><strong>{topic._count.articles}</strong></td>
        <td className="text-muted" style={{ maxWidth: "240px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {topic.description ?? <span className="text-muted">—</span>}
        </td>
        <td>
          <div className="topic-actions">
            <details className="scope-edit-dropdown">
              <summary className="btn btn-secondary btn-sm">Edit</summary>
              <div className="scope-edit-panel">
                <p className="scope-edit-title">Edit: {topic.name}</p>
                <form action={updateTopicAction} className="scope-edit-form">
                  <input type="hidden" name="id" value={topic.id} />
                  <div className="form-group">
                    <label className="form-label">Name</label>
                    <input name="name" type="text" className="form-input" defaultValue={topic.name} maxLength={100} required />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Slug</label>
                    <input name="slug" type="text" className="form-input" defaultValue={topic.slug} pattern="[a-z0-9-]+" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Parent</label>
                    <select name="parentId" className="form-input" defaultValue={topic.parentId ?? ""}>
                      <option value="">— Top-level —</option>
                      {allTopics
                        .filter((t) => t.id !== topic.id)
                        .map((t) => (
                          <option key={t.id} value={t.id}>{t.name}</option>
                        ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Description</label>
                    <input name="description" type="text" className="form-input" defaultValue={topic.description ?? ""} maxLength={255} />
                  </div>
                  <div className="scope-edit-actions">
                    <button type="submit" className="btn btn-primary btn-sm">Save</button>
                  </div>
                </form>
              </div>
            </details>
            <form action={deleteTopicAction} className="inline-form">
              <input type="hidden" name="id" value={topic.id} />
              <button
                type="submit"
                className="btn btn-danger btn-sm"
                onClick={(e) => {
                  if (!confirm(`Delete topic "${topic.name}"? This cannot be undone.`)) {
                    e.preventDefault();
                  }
                }}
              >
                Delete
              </button>
            </form>
          </div>
        </td>
      </tr>
      {topic.children.map((child) => (
        <TopicRow key={child.id} topic={child} allTopics={allTopics} depth={depth + 1} />
      ))}
    </>
  );
}
