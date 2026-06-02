export const LINT_MAX_ARTICLES_DEFAULT = 500;
export const LINT_MAX_ARTICLES_HARD_LIMIT = 2000;
export const LINT_STALE_DAYS_MIN = 1;
export const LINT_STALE_DAYS_MAX = 3650;
export const LINT_TAG_MIN_MIN = 1;
export const LINT_TAG_MIN_MAX = 100;

export interface LintOptions {
  staleDays: number;
  tagMin: number;
  maxArticles: number;
}

export type ParseLintOptionsResult =
  | { ok: true; options: LintOptions }
  | { ok: false; error: string };

export function parseLintOptions(body: {
  staleDays?: unknown;
  tagMin?: unknown;
  maxArticles?: unknown;
}): ParseLintOptionsResult {
  const rawStaleDays = body.staleDays;
  if (
    rawStaleDays !== undefined
    && (typeof rawStaleDays !== "number" || !Number.isFinite(rawStaleDays))
  ) {
    return { ok: false, error: "staleDays must be a finite number" };
  }

  const rawTagMin = body.tagMin;
  if (
    rawTagMin !== undefined
    && (typeof rawTagMin !== "number" || !Number.isFinite(rawTagMin))
  ) {
    return { ok: false, error: "tagMin must be a finite number" };
  }

  const parsedMaxArticles = Number(body.maxArticles);

  return {
    ok: true,
    options: {
      staleDays: rawStaleDays !== undefined
        ? Math.min(Math.max(LINT_STALE_DAYS_MIN, Math.floor(rawStaleDays)), LINT_STALE_DAYS_MAX)
        : 90,
      tagMin: rawTagMin !== undefined
        ? Math.min(Math.max(LINT_TAG_MIN_MIN, Math.floor(rawTagMin)), LINT_TAG_MIN_MAX)
        : 2,
      maxArticles: Number.isNaN(parsedMaxArticles)
        ? LINT_MAX_ARTICLES_DEFAULT
        : Math.min(Math.max(1, parsedMaxArticles), LINT_MAX_ARTICLES_HARD_LIMIT),
    },
  };
}
