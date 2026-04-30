import crypto from "crypto";
import { slugify } from "@/lib/memory/backfill";
import type { Prisma } from "@prisma/client";

export const MEMORY_SAVE_LIMITS = {
  maxTitleLength: 160,
  maxContentLength: 50_000,
  maxExcerptLength: 500,
  maxTopicIdLength: 128,
  maxTagCount: 12,
  maxTagLength: 64,
  minDurableContentLength: 40,
} as const;

const INJECTED_MEMORY_BLOCKS = [
  "recall",
  "hindsight_memories",
  "noosphere_auto_recall",
] as const;

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "Noosphere API key", pattern: /\bnoo_[A-Za-z0-9_-]{16,}\b/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  {
    name: "generic bearer token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i,
  },
  { name: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

const TRANSIENT_ONLY_PATTERNS = [
  /^(thanks?|thank you|ok(?:ay)?|done|yes|no|sure|great|nice|cool)[.!\s]*$/i,
  /^(i'?ll|we'?ll) (check|look|do|handle|get back).{0,80}$/i,
  /^(remind me|ping me|wake me).{0,120}$/i,
];

export interface MemorySaveRequest {
  title?: string;
  content?: string;
  topicId?: string;
  excerpt?: string;
  tags?: string[];
  source?: string;
  authorName?: string;
  confidence?: "low" | "medium" | "high";
}

export interface SanitizedMemorySaveInput {
  title: string;
  content: string;
  topicId: string;
  excerpt?: string;
  tags: string[];
  source?: string;
  authorName?: string;
  confidence?: "low" | "medium" | "high";
  status: "draft";
  strippedBlocks: string[];
}

export interface SavedMemoryCandidate {
  id: string;
  title: string;
  slug: string;
  topicId: string;
  topic?: { id: string; name: string; slug: string };
  status: "draft";
  url?: string;
}

export interface MemorySaveResponse {
  success: true;
  candidate: SavedMemoryCandidate;
  strippedBlocks: string[];
}

export interface MemorySaveWriter {
  saveCandidate(input: SanitizedMemorySaveInput): Promise<SavedMemoryCandidate>;
}

export interface MemorySaveExecutionOptions {
  writer?: MemorySaveWriter;
}

export type MemorySaveValidationResult =
  | { ok: true; input: SanitizedMemorySaveInput }
  | { ok: false; status: number; error: string };

export async function executeMemorySaveRequest(
  input: unknown,
  options: MemorySaveExecutionOptions = {},
): Promise<{ status: number; body: MemorySaveResponse | { error: string } }> {
  const validation = validateMemorySaveRequest(input);
  if (!validation.ok) {
    return { status: validation.status, body: { error: validation.error } };
  }

  const writer = options.writer ?? (await getDefaultMemorySaveWriter());
  const candidate = await writer.saveCandidate(validation.input);

  return {
    status: 201,
    body: {
      success: true,
      candidate,
      strippedBlocks: validation.input.strippedBlocks,
    },
  };
}

export function validateMemorySaveRequest(
  input: unknown,
): MemorySaveValidationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, status: 400, error: "Request body must be an object" };
  }

  const body = input as Record<string, unknown>;
  const title = readRequiredString(
    body.title,
    "title",
    MEMORY_SAVE_LIMITS.maxTitleLength,
  );
  if (!title.ok) return title;
  const content = readRequiredString(
    body.content,
    "content",
    MEMORY_SAVE_LIMITS.maxContentLength,
  );
  if (!content.ok) return content;
  const topicId = readRequiredString(
    body.topicId,
    "topicId",
    MEMORY_SAVE_LIMITS.maxTopicIdLength,
  );
  if (!topicId.ok) return topicId;
  const excerpt = readOptionalString(
    body.excerpt,
    "excerpt",
    MEMORY_SAVE_LIMITS.maxExcerptLength,
  );
  if (!excerpt.ok) return excerpt;
  const source = readOptionalString(body.source, "source", 500);
  if (!source.ok) return source;
  const authorName = readOptionalString(body.authorName, "authorName", 100);
  if (!authorName.ok) return authorName;
  const tags = readOptionalTags(body.tags);
  if (!tags.ok) return tags;
  const confidence = readOptionalConfidence(body.confidence);
  if (!confidence.ok) return confidence;

  const stripped = stripInjectedMemoryBlocks(content.value);
  const sanitizedContent = normalizeContent(stripped.content);
  const durableError = validateDurableContent(sanitizedContent);
  if (durableError) return durableError;

  const secretError = detectSecretInInputs([
    { field: "content", value: sanitizedContent },
    { field: "title", value: title.value },
    { field: "excerpt", value: excerpt.value },
    { field: "source", value: source.value },
    { field: "authorName", value: authorName.value },
    ...tags.value.map((value) => ({ field: "tags", value })),
  ]);
  if (secretError) return secretError;

  return {
    ok: true,
    input: {
      title: title.value,
      content: sanitizedContent,
      topicId: topicId.value,
      excerpt: excerpt.value,
      tags: tags.value,
      source: source.value,
      authorName: authorName.value,
      confidence: confidence.value,
      status: "draft",
      strippedBlocks: stripped.strippedBlocks,
    },
  };
}

export function stripInjectedMemoryBlocks(content: string): {
  content: string;
  strippedBlocks: string[];
} {
  let strippedContent = content;
  const strippedBlocks: string[] = [];

  for (const tag of INJECTED_MEMORY_BLOCKS) {
    let nextContent = stripOneInjectedTag(strippedContent, tag);
    while (nextContent.changed) {
      strippedBlocks.push(tag);
      strippedContent = nextContent.content;
      nextContent = stripOneInjectedTag(strippedContent, tag);
    }
  }

  return { content: strippedContent, strippedBlocks };
}

function stripOneInjectedTag(
  content: string,
  tag: string,
): { content: string; changed: boolean } {
  const openPattern = new RegExp(`<${tag}\\b[^>]*>`, "i");
  const openMatch = openPattern.exec(content);
  if (!openMatch) return { content, changed: false };

  const closePattern = new RegExp(`<\/${tag}>`, "gi");
  const openSearchPattern = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  closePattern.lastIndex = openMatch.index + openMatch[0].length;
  openSearchPattern.lastIndex = openMatch.index + openMatch[0].length;
  let depth = 1;
  let cursor = openMatch.index + openMatch[0].length;

  while (true) {
    openSearchPattern.lastIndex = cursor;
    closePattern.lastIndex = cursor;
    const nestedOpen = openSearchPattern.exec(content);
    const closeMatch = closePattern.exec(content);

    if (!closeMatch) {
      return {
        content: `${content.slice(0, openMatch.index)}
`,
        changed: true,
      };
    }

    if (nestedOpen && nestedOpen.index < closeMatch.index) {
      depth += 1;
      cursor = nestedOpen.index + nestedOpen[0].length;
      continue;
    }

    depth -= 1;
    cursor = closeMatch.index + closeMatch[0].length;
    if (depth === 0) {
      return {
        content: `${content.slice(0, openMatch.index)}
${content.slice(cursor)}`,
        changed: true,
      };
    }
  }
}

export async function getDefaultMemorySaveWriter(): Promise<MemorySaveWriter> {
  const { prisma } = await import("@/lib/prisma");

  return {
    async saveCandidate(input) {
      const topic = await prisma.topic.findUnique({
        where: { id: input.topicId },
        select: { id: true, name: true, slug: true },
      });
      if (!topic) {
        throw new MemorySaveError("Topic not found", 404);
      }

      const baseSlug = slugify(input.title).slice(0, 80);
      const excerpt = input.excerpt ?? createFallbackExcerpt(input.content);

      const article = await prisma.$transaction(async (tx) => {
        const slug = await findAvailableSlug(tx, input.topicId, baseSlug);
        const tagConnections = input.tags.map((tagName) => ({
          tag: {
            connectOrCreate: {
              where: { slug: slugify(tagName) },
              create: { name: tagName, slug: slugify(tagName) },
            },
          },
        }));
        const created = await tx.article.create({
          data: {
            title: input.title,
            slug,
            content: input.content,
            excerpt,
            topicId: input.topicId,
            authorName: input.authorName ?? "OpenClaw Noosphere Bridge",
            confidence: input.confidence ?? "low",
            status: "draft",
            sourceType: "memory_candidate",
            sourceUrl: input.source ?? null,
            tags: { create: tagConnections },
            revisions: {
              create: {
                title: input.title,
                content: input.content,
              },
            },
          },
          include: { topic: true },
        });

        await tx.activityLog.create({
          data: {
            type: "memory_candidate_saved",
            title: `Memory candidate saved as "${input.title}"`,
            authorName: input.authorName ?? "OpenClaw Noosphere Bridge",
            sourceUrl: input.source ?? null,
            details: {
              articleId: created.id,
              topicId: input.topicId,
              topic: topic.name,
              status: "draft",
              confidence: input.confidence ?? "low",
              tagCount: input.tags.length,
              strippedBlocks: input.strippedBlocks,
            },
          },
        });

        return created;
      });

      return {
        id: article.id,
        title: article.title,
        slug: article.slug,
        topicId: article.topicId,
        topic: {
          id: article.topic.id,
          name: article.topic.name,
          slug: article.topic.slug,
        },
        status: "draft",
        url: `/wiki/${article.topic.slug}/${article.slug}`,
      };
    },
  };

  async function findAvailableSlug(
    tx: Prisma.TransactionClient,
    topicId: string,
    baseSlug: string,
  ): Promise<string> {
    const existingArticles = await tx.article.findMany({
      where: { topicId, slug: { startsWith: baseSlug } },
      select: { slug: true },
    });
    const existingSlugs = new Set(
      existingArticles.map((article) => article.slug),
    );

    for (let index = 0; index < 100; index += 1) {
      const candidate = index === 0 ? baseSlug : `${baseSlug}-${index + 1}`;
      if (!existingSlugs.has(candidate)) return candidate;
    }

    // Fall back to UUID-based slug when all numeric suffixes exhausted
    const uuidSuffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const fallback = `${baseSlug}-${uuidSuffix}`;
    if (!existingSlugs.has(fallback)) return fallback;

    throw new MemorySaveError(
      "Could not generate a unique candidate slug",
      409,
    );
  }
}

export class MemorySaveError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MemorySaveError";
  }
}

function createFallbackExcerpt(content: string): string {
  return content
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 200)
    .trim();
}

function detectSecretInInputs(
  values: Array<{ field: string; value: string | undefined }>,
): Extract<MemorySaveValidationResult, { ok: false }> | undefined {
  for (const { field, value } of values) {
    if (!value) continue;
    const secretError = detectSecret(value, field);
    if (secretError) return secretError;
  }
  return undefined;
}

function normalizeContent(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function validateDurableContent(
  content: string,
): Extract<MemorySaveValidationResult, { ok: false }> | undefined {
  if (content.length < MEMORY_SAVE_LIMITS.minDurableContentLength) {
    return {
      ok: false,
      status: 400,
      error: "content is too short to save as durable memory",
    };
  }

  if (!/[a-zA-Z]{12,}/.test(content.replace(/\s+/g, ""))) {
    return {
      ok: false,
      status: 400,
      error: "content must contain meaningful prose",
    };
  }

  if (TRANSIENT_ONLY_PATTERNS.some((pattern) => pattern.test(content))) {
    return {
      ok: false,
      status: 400,
      error:
        "content looks transient and should not be saved as durable memory",
    };
  }

  return undefined;
}

function detectSecret(
  value: string,
  field: string,
): Extract<MemorySaveValidationResult, { ok: false }> | undefined {
  const match = SECRET_PATTERNS.find((entry) => entry.pattern.test(value));
  if (!match) return undefined;
  return {
    ok: false,
    status: 400,
    error: `${field} appears to contain a secret (${match.name})`,
  };
}

function readRequiredString(
  value: unknown,
  field: string,
  maxLength: number,
):
  | { ok: true; value: string }
  | Extract<MemorySaveValidationResult, { ok: false }> {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, status: 400, error: `${field} is required` };
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    return { ok: false, status: 400, error: `${field} is too long` };
  }
  return { ok: true, value: trimmed };
}

function readOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
):
  | { ok: true; value: string | undefined }
  | Extract<MemorySaveValidationResult, { ok: false }> {
  if (value === undefined || value === null)
    return { ok: true, value: undefined };
  if (typeof value !== "string") {
    return { ok: false, status: 400, error: `${field} must be a string` };
  }
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: undefined };
  if (trimmed.length > maxLength) {
    return { ok: false, status: 400, error: `${field} is too long` };
  }
  return { ok: true, value: trimmed };
}

function readOptionalTags(
  value: unknown,
):
  | { ok: true; value: string[] }
  | Extract<MemorySaveValidationResult, { ok: false }> {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) {
    return {
      ok: false,
      status: 400,
      error: "tags must be an array of strings",
    };
  }
  if (value.length > MEMORY_SAVE_LIMITS.maxTagCount) {
    return { ok: false, status: 400, error: "too many tags" };
  }

  const tags: string[] = [];
  for (const tag of value) {
    if (typeof tag !== "string") {
      return {
        ok: false,
        status: 400,
        error: "tags must be an array of strings",
      };
    }
    const normalized = tag.trim();
    if (!normalized) continue;
    if (normalized.length > MEMORY_SAVE_LIMITS.maxTagLength) {
      return { ok: false, status: 400, error: "tag is too long" };
    }
    const normalizedSlug = slugify(normalized);
    if (!normalizedSlug) continue;
    if (!tags.some((existing) => slugify(existing) === normalizedSlug)) {
      tags.push(normalized);
    }
  }
  return { ok: true, value: tags };
}

function readOptionalConfidence(
  value: unknown,
):
  | { ok: true; value: "low" | "medium" | "high" | undefined }
  | Extract<MemorySaveValidationResult, { ok: false }> {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: undefined };
  }
  if (value === "low" || value === "medium" || value === "high") {
    return { ok: true, value };
  }
  return {
    ok: false,
    status: 400,
    error: "confidence must be low/medium/high",
  };
}
