import crypto from "node:crypto";

export type ArticleRecallSource = {
  title: string;
  excerpt?: string | null;
  content: string;
  tags?: readonly string[];
  sourceType?: string | null;
};

/**
 * Stable hash for recall-enrichment staleness. Scope and lifecycle metadata are
 * intentionally excluded: they gate eligibility independently and must never
 * make the machine recall document a second authorization source of truth.
 */
export function computeArticleRecallSourceHash(
  source: ArticleRecallSource,
): string {
  const canonical = JSON.stringify({
    version: 1,
    title: normalizeCanonicalText(source.title),
    excerpt: normalizeCanonicalText(source.excerpt ?? ""),
    content: normalizeCanonicalText(source.content),
    tags: [...new Set((source.tags ?? []).map(normalizeCanonicalText).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right)),
    sourceType: normalizeCanonicalText(source.sourceType ?? ""),
  });
  return `sha256:${crypto.createHash("sha256").update(canonical).digest("hex")}`;
}

function normalizeCanonicalText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
