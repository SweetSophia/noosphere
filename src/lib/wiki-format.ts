export const wikiDateFormatter = new Intl.DateTimeFormat("en-GB", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

export function articleCardLabel(article: {
  title: string;
  topicName?: string;
  author?: { name: string | null } | null;
  authorName?: string | null;
  status?: string;
  confidence?: string | null;
  restrictedTags: string[];
}) {
  const restriction =
    article.restrictedTags.length > 0
      ? `Restricted article (${article.restrictedTags.join(", ")})`
      : "Article";
  const topic = article.topicName ? ` in ${article.topicName}` : "";
  const author = article.author?.name ?? article.authorName;
  const lead = `${restriction}: ${article.title}${topic}${author ? `, by ${author}` : ""}.`;
  const details = [
    article.status ? `Status: ${article.status}.` : null,
    article.confidence ? `Confidence: ${article.confidence}.` : null,
  ];

  return [lead, ...details].filter(Boolean).join(" ");
}
