import { NextRequest } from "next/server";

/**
 * Create a mock NextRequest for testing API route handlers.
 */
export function mockNextRequest(options: {
  url?: string;
  method?: string;
  body?: object;
  headers?: Record<string, string>;
}): NextRequest {
  const url = options.url ?? "http://localhost/api/articles";
  const request = new Request(url, {
    method: options.method ?? "GET",
    headers: options.headers ?? {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  return request as unknown as NextRequest;
}

/**
 * Parse a NextResponse JSON body for assertions.
 */
export async function parseJson(response: Response): Promise<unknown> {
  return response.json();
}

/**
 * Create a mock Prisma article for route tests.
 */
export function mockArticle(overrides: Record<string, unknown> = {}) {
  return {
    id: "article-1",
    title: "Test Article",
    slug: "test-article",
    content: "# Test\n\nThis is test content.",
    excerpt: "This is test content.",
    topicId: "topic-1",
    authorId: null,
    authorName: "Test Author",
    confidence: null,
    status: "published",
    sourceUrl: null,
    sourceType: null,
    lastReviewed: null,
    deletedAt: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}
