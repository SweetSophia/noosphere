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
  const page = Math.max(1, parseInt(searchParams.get("page") ?? String(defaults.page ?? 1), 10));
  const limit = Math.min(
    Math.max(1, parseInt(searchParams.get("limit") ?? String(defaults.limit ?? 20), 10)),
    maxLimit
  );
  return { page, limit, offset: (page - 1) * limit };
}
