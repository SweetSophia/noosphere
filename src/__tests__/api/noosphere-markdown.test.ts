import assert from "node:assert/strict";
import test from "node:test";
import yaml from "js-yaml";
import {
  computeNoosphereContentHash,
  parseNoosphereMarkdown,
  readMarkdownString,
  readMarkdownStringArray,
  renderNoosphereMarkdown,
} from "@/lib/markdown/noosphere-markdown";

const article = {
  id: "article-1",
  slug: "connection-pooling",
  title: "Connection Pooling",
  topic: "prisma",
  topicPath: ["engineering", "backend", "prisma"],
  content: "# Connection Pooling\n\nUse bounded pools for database clients.",
  tags: ["postgresql", "performance", "postgresql"],
  restrictedTags: ["serianis-project"],
  confidence: "high",
  status: "published",
  authorName: "Cylena",
  sourceUrl: "https://example.com/docs",
  sourceType: "url",
  createdAt: new Date("2026-04-01T10:00:00Z"),
  updatedAt: new Date("2026-04-15T14:32:11Z"),
};

test("renderNoosphereMarkdown emits parseable versioned frontmatter", () => {
  const markdown = renderNoosphereMarkdown(article, {
    contentHash: "abc123",
    syncedAt: "2026-04-15T14:35:00.000Z",
    publish: true,
  });

  const parsed = parseNoosphereMarkdown(markdown);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const fm = parsed.markdown.frontmatter;
  assert.equal(fm["id"], "article-1");
  assert.equal(fm["slug"], "connection-pooling");
  assert.deepEqual(fm["topicPath"], ["engineering", "backend", "prisma"]);
  assert.deepEqual(fm["tags"], ["postgresql", "performance"]);
  assert.deepEqual(fm["restrictedTags"], ["serianis-project"]);
  assert.equal(fm["publish"], true);
  assert.equal(parsed.markdown.content, article.content);

  const noosphere = fm["noosphere"] as Record<string, unknown>;
  assert.equal(noosphere["entity"], "article");
  assert.equal(noosphere["schemaVersion"], 1);
  assert.equal(noosphere["contentHash"], "sha256:abc123");
  assert.equal(noosphere["sourceOfTruth"], "database");
  assert.equal(noosphere["url"], "/wiki/engineering/backend/prisma/connection-pooling");
});

test("renderNoosphereMarkdown uses stable key order", () => {
  const markdown = renderNoosphereMarkdown(article, {
    contentHash: "abc123",
    syncedAt: "2026-04-15T14:35:00.000Z",
  });
  const frontmatter = markdown.slice(4, markdown.indexOf("\n---\n"));
  const idIndex = frontmatter.indexOf("id:");
  const slugIndex = frontmatter.indexOf("slug:");
  const titleIndex = frontmatter.indexOf("title:");
  const noosphereIndex = frontmatter.indexOf("noosphere:");

  assert.ok(idIndex < slugIndex);
  assert.ok(slugIndex < titleIndex);
  assert.ok(titleIndex < noosphereIndex);
  assert.doesNotThrow(() => yaml.load(frontmatter));
});

test("computeNoosphereContentHash ignores syncedAt but tracks content", () => {
  const hashA = computeNoosphereContentHash(article);
  const hashB = computeNoosphereContentHash({ ...article });
  const hashC = computeNoosphereContentHash({ ...article, content: `${article.content}\n\nUpdated.` });

  assert.equal(hashA, hashB);
  assert.notEqual(hashA, hashC);
});

test("parseNoosphereMarkdown reports missing and invalid frontmatter distinctly", () => {
  assert.deepEqual(parseNoosphereMarkdown("# Missing frontmatter"), {
    ok: false,
    error: "No YAML frontmatter found",
  });
  assert.deepEqual(parseNoosphereMarkdown("---\n:\n---\nBody"), {
    ok: false,
    error: "Invalid YAML frontmatter",
  });
});

test("readMarkdownString helpers normalize imported metadata", () => {
  const frontmatter = {
    title: "  Title  ",
    tags: [" alpha ", "beta", "alpha", 42],
    restrictedTags: "not-an-array",
  };

  assert.equal(readMarkdownString(frontmatter, "title"), "Title");
  assert.deepEqual(readMarkdownStringArray(frontmatter, "tags"), ["alpha", "beta"]);
  assert.deepEqual(readMarkdownStringArray(frontmatter, "restrictedTags"), []);
});
