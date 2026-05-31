/**
 * Pure wiki utility functions.
 *
 * This module is intentionally free of prisma and other database dependencies
 * so it can be imported freely in tests and any other context.
 *
 * @module wiki-utils
 */

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9 -]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .trim() || ""
  );
}

export function parseTagInput(raw: string | null | undefined): string[] {
  if (!raw) return [];

  return Array.from(
    new Set(
      raw
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  );
}

export interface NormalizedTagInput {
  name: string;
  slug: string;
}

export function normalizeTagInputs(tagNames: string[]): NormalizedTagInput[] {
  const bySlug = new Map<string, NormalizedTagInput>();

  for (const name of tagNames) {
    const trimmed = name.trim();
    const slug = slugify(trimmed);
    if (!slug || bySlug.has(slug)) continue;

    bySlug.set(slug, { name: trimmed, slug });
  }

  return Array.from(bySlug.values());
}
