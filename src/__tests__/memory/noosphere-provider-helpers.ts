import type { PrismaClient } from "@prisma/client";

export function createMockPrisma(
  overrides: Record<string, unknown> = {},
): PrismaClient {
  return {
    article: {
      findFirst: (() =>
        Promise.resolve(null)) as unknown as PrismaClient["article"]["findFirst"],
      findMany: (() =>
        Promise.resolve(
          [],
        )) as unknown as PrismaClient["article"]["findMany"],
    },
    $queryRaw: (() =>
      Promise.resolve([])) as unknown as PrismaClient["$queryRaw"],
    ...overrides,
  } as unknown as PrismaClient;
}

export function createSequentialQueryRaw(rowsByCall: unknown[][]) {
  let callIndex = 0;
  return () => {
    const rows = rowsByCall[Math.min(callIndex, rowsByCall.length - 1)] ?? [];
    callIndex++;
    return Promise.resolve(rows);
  };
}

export function mockArticle(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-id",
    title: "Test Article",
    slug: "test-article",
    content: "Test content body",
    excerpt: "Test excerpt",
    status: "published",
    confidence: "high",
    sourceUrl: null,
    sourceType: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-04-01"),
    lastReviewed: null,
    authorId: null,
    authorName: null,
    topicId: "topic-1",
    topic: { id: "topic-1", slug: "engineering", name: "Engineering" },
    tags: [],
    ...overrides,
  };
}

export function mockSearchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "article-1",
    rank: 1,
    title: "Article",
    slug: "article",
    content: "Article content",
    excerpt: "Article excerpt",
    status: "published",
    confidence: "high",
    sourceUrl: null,
    sourceType: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-02"),
    lastReviewed: null,
    authorId: null,
    authorName: null,
    topicId: "topic-1",
    topicSlug: "engineering",
    topicName: "Engineering",
    tagName: null,
    ...overrides,
  };
}
