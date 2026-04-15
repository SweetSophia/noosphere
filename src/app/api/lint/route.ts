import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiKey } from "@/lib/api/keys";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

// POST /api/lint — Wiki health check
//
// Scans the wiki for quality issues:
// - Orphan articles (no inbound connections via tags or cross-refs)
// - Stale articles (not updated in N days)
// - Unlinked mentions (article titles mentioned but not linked)
// - Tag orphans (tags with only 1 article)
// - Broken wikilinks (pointing to non-existent articles)
//
// Auth: API key (WRITE/ADMIN) or session (EDITOR/ADMIN)
//
// Body (all optional):
//   staleDays  — articles not updated in this many days are "stale" (default 90)
//   tagMin     — minimum articles per tag to not be a "tag orphan" (default 2)
//
// Response:
//   { runAt, issues: [{type, severity, articleId?, title?, details}], summary: {total, byType, bySeverity} }

interface LintIssue {
  type: string;
  severity: "low" | "medium" | "high";
  articleId?: string;
  title?: string;
  details: string;
}

export async function POST(request: NextRequest) {
  // --- Auth ---
  const apiAuth = await requireApiKey(request);
  const session = await getServerSession(authOptions);

  if (!apiAuth.authorized && !session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (apiAuth.authorized) {
    if (apiAuth.permissions !== "WRITE" && apiAuth.permissions !== "ADMIN") {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }
  } else {
    const role = (session?.user as { role?: string }).role;
    if (role !== "EDITOR" && role !== "ADMIN") {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }
  }

  // --- Parse options ---
  let body: { staleDays?: number; tagMin?: number } = {};
  try {
    body = await request.json();
  } catch {
    // No body — use defaults
  }

  const staleDays = body.staleDays ?? 90;
  const tagMin = body.tagMin ?? 2;
  const staleThreshold = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);

  const issues: LintIssue[] = [];

  // ── Fetch all non-deleted articles ──
  const articles = await prisma.article.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      title: true,
      slug: true,
      content: true,
      updatedAt: true,
      topic: { select: { slug: true, name: true } },
      tags: { select: { tag: { select: { id: true, name: true, slug: true } } } },
    },
  });

  const articleMap = new Map(articles.map((a) => [a.slug, a]));
  const articleIdMap = new Map(articles.map((a) => [a.id, a]));
  const topicSlugSet = new Set(articles.map((a) => a.topic.slug));

  // ── 1. Orphan articles ──
  // An orphan has no topic-edge (same-topic) and no tag-edge and no cross_ref
  // We check this by building inbound connection sets

  // Build tag → article mapping
  const tagToArticles = new Map<string, string[]>();
  for (const a of articles) {
    for (const { tag } of a.tags) {
      const list = tagToArticles.get(tag.id) ?? [];
      list.push(a.id);
      tagToArticles.set(tag.id, list);
    }
  }

  // Build cross_ref edges from content
  const crossRefTargets = new Map<string, Set<string>>();
  for (const a of articles) {
    const targets = new Set<string>();

    // [[slug]] wikilinks
    const wikiLinkRegex = /\[\[([a-z0-9-]+)\]\]/gi;
    let match;
    while ((match = wikiLinkRegex.exec(a.content)) !== null) {
      const targetSlug = match[1].toLowerCase();
      if (articleMap.has(targetSlug)) {
        targets.add(targetSlug);
      }
    }

    // /wiki/topic/slug hrefs
    const hrefRegex = /\/wiki\/([a-z0-9-]+)\/([a-z0-9-]+)/gi;
    while ((match = hrefRegex.exec(a.content)) !== null) {
      const refTopic = match[1].toLowerCase();
      const refSlug = match[2].toLowerCase();
      if (topicSlugSet.has(refTopic)) {
        const target = articleMap.get(refSlug);
        if (target) targets.add(refSlug);
      }
    }

    if (targets.size > 0) {
      crossRefTargets.set(a.id, targets);
    }
  }

  for (const a of articles) {
    const hasTopicEdge = articles.some(
      (b) => b.id !== a.id && b.topic.slug === a.topic.slug
    );
    const hasTagEdge = a.tags.some(({ tag }) => (tagToArticles.get(tag.id)?.length ?? 0) > 1);
    const hasCrossRef = (crossRefTargets.get(a.id)?.size ?? 0) > 0;

    if (!hasTopicEdge && !hasTagEdge && !hasCrossRef) {
      issues.push({
        type: "orphan",
        severity: a.tags.length === 0 ? "high" : "medium",
        articleId: a.id,
        title: a.title,
        details: `No topic siblings, no shared tags, and no cross-references to or from other articles.`,
      });
    }
  }

  // ── 2. Stale articles ──
  for (const a of articles) {
    if (a.updatedAt < staleThreshold) {
      const daysSince = Math.floor(
        (Date.now() - a.updatedAt.getTime()) / (24 * 60 * 60 * 1000)
      );
      issues.push({
        type: "stale",
        severity: daysSince > staleDays * 2 ? "low" : "low",
        articleId: a.id,
        title: a.title,
        details: `Not updated in ${daysSince} days (threshold: ${staleDays}).`,
      });
    }
  }

  // ── 3. Broken wikilinks ──
  for (const a of articles) {
    const brokenLinks: string[] = [];

    const wikiLinkRegex = /\[\[([a-z0-9-]+)\]\]/gi;
    let match;
    while ((match = wikiLinkRegex.exec(a.content)) !== null) {
      const slug = match[1].toLowerCase();
      if (!articleMap.has(slug)) {
        brokenLinks.push(`[[${slug}]]`);
      }
    }

    if (brokenLinks.length > 0) {
      issues.push({
        type: "broken_link",
        severity: "high",
        articleId: a.id,
        title: a.title,
        details: `Broken wikilinks: ${brokenLinks.join(", ")}`,
      });
    }
  }

  // ── 4. Tag orphans ──
  const tagOrphanTags = [...tagToArticles.entries()].filter(
    ([, ids]) => ids.length < tagMin
  );
  for (const [tagId, articleIds] of tagOrphanTags) {
    const tagName = articles
      .flatMap((a) => a.tags)
      .find((t) => t.tag.id === tagId)?.tag.name;
    issues.push({
      type: "tag_orphan",
      severity: "low",
      details: `Tag "${tagName}" (${tagId}) only tags ${articleIds.length} article(s). Consider removing or merging.`,
    });
  }

  // ── 5. Unlinked mentions ──
  // Detect when an article title (or slug) appears in another article's content
  // but is not linked with [[slug]] or href
  for (const a of articles) {
    const unlinkedMentions: string[] = [];

    for (const b of articles) {
      if (b.id === a.id) continue;

      // Does b's content mention a's title or slug without linking?
      const titlePlain = new RegExp(`\\b${a.title}\\b`, "i");
      const slugPlain = new RegExp(`\\b${a.slug}\\b`, "i");
      const isLinked =
        new RegExp(`\\[\\[${a.slug}\\]\\]`, "i").test(b.content) ||
        new RegExp(`/wiki/[^/]*/${a.slug}(?![a-z0-9-])`, "i").test(b.content);

      if (!isLinked && (titlePlain.test(b.content) || slugPlain.test(b.content))) {
        unlinkedMentions.push(b.title);
      }
    }

    if (unlinkedMentions.length > 0) {
      issues.push({
        type: "unlinked_mention",
        severity: "low",
        articleId: a.id,
        title: a.title,
        details: `Mentioned but not linked in: ${[...new Set(unlinkedMentions)].join(", ")}`,
      });
    }
  }

  // ── 6. Empty or near-empty articles ──
  for (const a of articles) {
    const contentLength = a.content.replace(/[#*`_>\-\s]/g, "").length;
    if (contentLength < 50) {
      issues.push({
        type: "empty_content",
        severity: "medium",
        articleId: a.id,
        title: a.title,
        details: `Article content is very short (${contentLength} chars after stripping markdown).`,
      });
    }
  }

  // ── Summary ──
  const summary = {
    total: issues.length,
    byType: Object.fromEntries(
      [...new Map(issues.map((i) => [i.type, issues.filter((x) => x.type === i.type).length])).entries()]
        .sort((a, b) => b[1] - a[1])
    ),
    bySeverity: {
      high: issues.filter((i) => i.severity === "high").length,
      medium: issues.filter((i) => i.severity === "medium").length,
      low: issues.filter((i) => i.severity === "low").length,
    },
  };

  // ── Log the lint run ──
  const authorName = session?.user?.name || "API";

  await prisma.activityLog.create({
    data: {
      type: "lint",
      title: `Lint check — ${issues.length} issue(s) found`,
      authorName,
      details: {
        issuesFound: issues.length,
        byType: summary.byType,
        bySeverity: summary.bySeverity,
        staleDays,
        tagMin,
      },
    },
  });

  return NextResponse.json({
    success: true,
    runAt: new Date().toISOString(),
    options: { staleDays, tagMin },
    issues,
    summary,
  });
}
