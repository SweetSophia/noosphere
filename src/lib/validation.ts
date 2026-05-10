/**
 * Shared validation helpers used across API routes and server actions.
 */

import { slugify as wikiSlugify } from "@/lib/wiki";

export const SLUG_REGEX = /^[a-z0-9-]+$/;

export const VALID_STATUSES = ["draft", "reviewed", "published"] as const;
export type ValidStatus = (typeof VALID_STATUSES)[number];

export const VALID_CONFIDENCES = ["low", "medium", "high"] as const;
export type ValidConfidence = (typeof VALID_CONFIDENCES)[number];

export function isValidStatus(value: string): value is ValidStatus {
  return (VALID_STATUSES as readonly string[]).includes(value);
}

export function isValidConfidence(value: string): value is ValidConfidence {
  return (VALID_CONFIDENCES as readonly string[]).includes(value);
}

/**
 * Derive an excerpt from markdown content by stripping formatting characters.
 */
export function deriveExcerpt(content: string, maxLength = 160): string {
  return content
    .slice(0, maxLength)
    .replace(/[#*`>_\-\[\]]/g, "")
    .trim();
}

/**
 * Validate and normalize a slug.
 */
export function validateSlug(slug: string): { ok: true; slug: string } | { ok: false; error: string } {
  const trimmed = slug.trim();
  if (!trimmed) {
    return { ok: false, error: "Slug is required" };
  }
  if (!SLUG_REGEX.test(trimmed)) {
    return { ok: false, error: "Slug must be lowercase alphanumeric with hyphens only" };
  }
  return { ok: true, slug: trimmed };
}

/**
 * Sanitize an author name to prevent HTML injection and spoofing.
 */
export function sanitizeAuthorName(raw: string | undefined | null, maxLength = 100): string {
  if (!raw) return "";
  return raw
    .replace(/<[^>]*>/g, "")
    .trim()
    .slice(0, maxLength);
}

/**
 * Shared security limits for article content.
 */
export const ARTICLE_LIMITS = {
  maxContentSize: 1024 * 1024, // 1 MB
  maxTitleLength: 200,
  maxExcerptLength: 500,
  maxAuthorNameLength: 100,
} as const;
