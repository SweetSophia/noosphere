import type { PrismaClient } from "@prisma/client";

export function createMockPrisma(
  overrides: Record<string, unknown> = {},
): PrismaClient {
  const { article: articleOverride, ...clientOverrides } = overrides;
  const client = {
    article: {
      findFirst: (() =>
        Promise.resolve(null)) as unknown as PrismaClient["article"]["findFirst"],
      findMany: (() =>
        Promise.resolve(
          [],
        )) as unknown as PrismaClient["article"]["findMany"],
      ...((articleOverride as Record<string, unknown> | undefined) ?? {}),
    },
    $queryRaw: (() =>
      Promise.resolve([])) as unknown as PrismaClient["$queryRaw"],
    ...clientOverrides,
  } as unknown as PrismaClient;
  if (!("$transaction" in overrides)) {
    Object.assign(client, {
      $transaction: (callback: (tx: PrismaClient) => unknown) => callback(client),
    });
  }
  return client;
}

export function createSequentialQueryRaw(rowsByCall: unknown[][]) {
  let callIndex = 0;
  return () => {
    const rows = rowsByCall[Math.min(callIndex, rowsByCall.length - 1)] ?? [];
    callIndex++;
    return Promise.resolve(rows);
  };
}

/** Keep unit tests explicit about the provider's mandatory DB rehydration. */
export function withRecallHydrationQueries(
  queryRaw: (...args: unknown[]) => Promise<unknown>,
) {
  return (...args: unknown[]) => {
    const query = args[0] as { strings?: readonly string[]; values?: unknown[] };
    const sql = query.strings?.join(" ") ?? "";
    if (sql.includes('FROM "MemoryProvenanceEdge"')) {
      return Promise.resolve([]);
    }
    if (sql.includes('SELECT article.id') && sql.includes('FOR SHARE OF article')) {
      const ids = (query.values ?? []).filter(
        (value): value is string => typeof value === "string",
      );
      return Promise.resolve(ids.map((id) => ({ id })));
    }
    return queryRaw(...args);
  };
}

export function findManyFromArticles(
  articles: Array<ReturnType<typeof mockArticle>>,
) {
  return (args: { where?: { id?: { in?: string[] } } }) => {
    const ids = new Set(args.where?.id?.in ?? []);
    return Promise.resolve(articles.filter(({ id }) => ids.has(id)));
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
