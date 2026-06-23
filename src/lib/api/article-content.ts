import {
  SERVER_MEMORY_SAVE_STRIP_MODE,
  stripInjectedMemoryBlocks,
} from "@sweetsophia/noosphere-injected-memory";

export const ARTICLE_CONTENT_INJECTED_ONLY_ERROR =
  "Content must include durable text outside injected memory blocks";

export type ArticleContentSanitizationResult =
  | { ok: true; content: string; strippedBlocks: string[] }
  | { ok: false; status: 400; error: string };

export function sanitizeArticleContent(
  content: string,
): ArticleContentSanitizationResult {
  const stripped = stripInjectedMemoryBlocks(
    content,
    SERVER_MEMORY_SAVE_STRIP_MODE,
  );
  if (!stripped.content.trim()) {
    return {
      ok: false,
      status: 400,
      error: ARTICLE_CONTENT_INJECTED_ONLY_ERROR,
    };
  }

  return {
    ok: true,
    content: stripped.content,
    strippedBlocks: stripped.strippedBlocks,
  };
}

export function sanitizeArticleExcerpt(excerpt: string): {
  excerpt: string;
  strippedBlocks: string[];
} {
  const stripped = stripInjectedMemoryBlocks(
    excerpt,
    SERVER_MEMORY_SAVE_STRIP_MODE,
  );

  return {
    excerpt:
      stripped.strippedBlocks.length > 0 && !stripped.content.trim()
        ? ""
        : stripped.content,
    strippedBlocks: stripped.strippedBlocks,
  };
}
