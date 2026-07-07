import type { Prisma } from "@prisma/client";

export const topicPathSelect = {
  id: true,
  name: true,
  slug: true,
  parentId: true,
} satisfies Prisma.TopicSelect;

export type TopicPathNode = Prisma.TopicGetPayload<{ select: typeof topicPathSelect }>;

export function buildTopicPath(topics: TopicPathNode[], current: TopicPathNode) {
  const topicMap = new Map(topics.map((topic) => [topic.id, topic]));
  const path: TopicPathNode[] = [];
  const seen = new Set<string>();
  let cursor: TopicPathNode | undefined = current;

  while (cursor && !seen.has(cursor.id)) {
    path.unshift(cursor);
    seen.add(cursor.id);
    cursor = cursor.parentId ? topicMap.get(cursor.parentId) : undefined;
  }

  return path;
}

export function getTopicArticlesEmptyState(hasSubtopics: boolean) {
  return hasSubtopics
    ? {
        title: "No direct articles yet",
        description: "This branch is organized through subtopics. Open one below, or add a direct article here.",
        actionLabel: "Add direct article",
      }
    : {
        title: "No articles or subtopics yet",
        description: "This leaf topic is ready for its first article when there is something to preserve here.",
        actionLabel: "Create the first article",
      };
}
