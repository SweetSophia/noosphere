import assert from "node:assert/strict";
import test from "node:test";
import { buildTopicPath, getTopicArticlesEmptyState, type TopicPathNode } from "@/lib/wiki-topic-page";

const topics: TopicPathNode[] = [
  { id: "root", name: "Root", slug: "root", parentId: null },
  { id: "branch", name: "Branch", slug: "branch", parentId: "root" },
  { id: "leaf", name: "Leaf", slug: "leaf", parentId: "branch" },
];

test("topic page path builder returns ancestor breadcrumbs in order", () => {
  assert.deepEqual(
    buildTopicPath(topics, topics[2]).map((topic) => topic.slug),
    ["root", "branch", "leaf"],
  );
});

test("topic page path builder stops on cyclic parents", () => {
  const cyclicTopics: TopicPathNode[] = [
    { id: "a", name: "A", slug: "a", parentId: "b" },
    { id: "b", name: "B", slug: "b", parentId: "a" },
  ];

  assert.deepEqual(
    buildTopicPath(cyclicTopics, cyclicTopics[0]).map((topic) => topic.slug),
    ["b", "a"],
  );
});

test("topic page uses branch empty article copy when direct subtopics exist", () => {
  assert.deepEqual(getTopicArticlesEmptyState(true), {
    title: "No direct articles yet",
    description: "This branch is organized through subtopics. Open one below, or add a direct article here.",
    actionLabel: "Add direct article",
  });
});

test("topic page uses leaf empty article copy when no subtopics exist", () => {
  assert.deepEqual(getTopicArticlesEmptyState(false), {
    title: "No articles or subtopics yet",
    description: "This leaf topic is ready for its first article when there is something to preserve here.",
    actionLabel: "Create the first article",
  });
});
