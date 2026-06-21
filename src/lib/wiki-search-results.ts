import { buildScopeFilter } from "@/lib/api/scope-filter";

export function buildSearchResultHydrationWhere(
  articleIds: string[],
  allowedScopes: string[] | undefined,
) {
  return buildScopeFilter(allowedScopes, {
    id: { in: articleIds },
    deletedAt: null,
  });
}
