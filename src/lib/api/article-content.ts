import {
  SERVER_MEMORY_SAVE_STRIP_MODE,
  stripInjectedMemoryBlocks,
} from "@sweetsophia/noosphere-injected-memory";
import type { Prisma } from "@prisma/client";

export const ARTICLE_CONTENT_INJECTED_ONLY_ERROR =
  "Content must include durable text outside injected memory blocks";
export const ARTICLE_EXCERPT_INJECTED_ONLY_ERROR =
  "Excerpt must include durable text outside injected memory blocks";

export type ArticleContentSanitizationResult =
  | { ok: true; content: string; strippedBlocks: string[] }
  | { ok: false; status: 400; error: string };

export type ArticleExcerptSanitizationResult =
  | { ok: true; excerpt: string; strippedBlocks: string[] }
  | { ok: false; status: 400; error: string; strippedBlocks: string[] };

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

export function sanitizeArticleExcerpt(
  excerpt: string,
): ArticleExcerptSanitizationResult {
  const stripped = stripInjectedMemoryBlocks(
    excerpt,
    SERVER_MEMORY_SAVE_STRIP_MODE,
  );
  if (stripped.strippedBlocks.length > 0 && !stripped.content.trim()) {
    return {
      ok: false,
      status: 400,
      error: ARTICLE_EXCERPT_INJECTED_ONLY_ERROR,
      strippedBlocks: stripped.strippedBlocks,
    };
  }

  return {
    ok: true,
    excerpt: stripped.content,
    strippedBlocks: stripped.strippedBlocks,
  };
}

export type ArticleStripObservationField = Prisma.InputJsonObject & {
  field: string;
  strippedBlocks: string[];
};

export type ArticleStripObservation = Prisma.InputJsonObject;

export function buildArticleStripObservation(
  fields: ArticleStripObservationField[],
): Prisma.InputJsonObject | undefined {
  const activeFields = fields.filter((field) => field.strippedBlocks.length > 0);
  if (activeFields.length === 0) return undefined;

  const strippedBlocks: Record<string, number> = {};
  for (const field of activeFields) {
    for (const blockName of field.strippedBlocks) {
      strippedBlocks[blockName] = (strippedBlocks[blockName] ?? 0) + 1;
    }
  }

  return {
    strippedBlockCount: activeFields.reduce(
      (count, field) => count + field.strippedBlocks.length,
      0,
    ),
    strippedBlocks,
    fields: activeFields,
  };
}
