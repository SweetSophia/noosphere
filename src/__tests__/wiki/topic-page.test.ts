import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const topicPageSource = readFileSync(resolve("src/app/wiki/[topicSlug]/page.tsx"), "utf8");

test("topic page path builder uses Prisma payload typing", () => {
  assert.match(topicPageSource, /satisfies Prisma\.TopicSelect/);
  assert.match(topicPageSource, /type TopicPathNode = Prisma\.TopicGetPayload/);
  assert.doesNotMatch(topicPageSource, /interface TopicPathNode/);
  assert.match(topicPageSource, /select: topicPathSelect/);
});

test("topic page distinguishes leaf and branch empty article states", () => {
  assert.match(topicPageSource, /No direct articles yet/);
  assert.match(topicPageSource, /This branch is organized through subtopics/);
  assert.match(topicPageSource, /No articles or subtopics yet/);
  assert.match(topicPageSource, /This leaf topic is ready for its first article/);
});
