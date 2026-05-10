/**
 * Shared pagination helpers for API routes.
 */

export interface PaginationParams {
  page: number;
  limit: number;
  offset: number;
}

export function parsePagination(
  searchParams: { get: (key: string) => string | null },
  defaults: { page?: number; limit?: number; maxLimit?: number } = {}
): PaginationParams {
  const maxLimit = defaults.maxLimit ?? 100;
  const rawPage = parseInt(searchParams.get("page") ?? String(defaults.page ?? 1), 10);
  const rawLimit = parseInt(searchParams.get("limit") ?? String(defaults.limit ?? 20), 10);
  const page = Number.isNaN(rawPage) ? 1 : Math.max(1, rawPage);
  const limit = Number.isNaN(rawLimit) ? 20 : Math.min(Math.max(1, rawLimit), maxLimit);
  return { page, limit, offset: (page - 1) * limit };
}
