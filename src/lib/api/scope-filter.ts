/**
 * Pure scope-filtering logic for article access control.
 *
 * This module is intentionally free of prisma, next-auth, and other
 * database or network dependencies so it can be imported freely in tests
 * and any other context.
 *
 * @module scope-filter
 */

/**
 * Build a Prisma WHERE clause that filters articles based on key scopes.
 * Articles with no restrictedTags are always accessible.
 * Articles with restrictedTags require at least one matching scope.
 *
 * @param allowedScopes - The scopes available to the current key (from AuthResult)
 * @param extraWhere - Additional Prisma filters to AND with the scope filter
 */
export function buildScopeFilter(
  allowedScopes: string[] | undefined,
  extraWhere: Record<string, unknown> = {},
): Record<string, unknown> {
  // If scopes include "*", grant admin access — no scope restriction at all
  if (allowedScopes?.includes("*")) {
    return extraWhere;
  }

  // No scopes at all (undefined or empty): can only access unrestricted articles
  if (!allowedScopes || allowedScopes.length === 0) {
    return {
      ...extraWhere,
      restrictedTags: { isEmpty: true },
    };
  }

  // Non-admin key with scopes: unrestricted OR at least one matching scope
  return {
    ...extraWhere,
    OR: [
      { restrictedTags: { isEmpty: true } },
      { restrictedTags: { hasSome: allowedScopes } },
    ],
  };
}

/**
 * Check whether the current auth context grants access to a given article's restricted scopes.
 * Returns true if the article is unrestricted OR has at least one matching scope.
 *
 * @param articleScopes - restrictedTags from the article
 * @param allowedScopes - scopes from AuthResult
 */
export function canAccessScopes(
  articleScopes: string[],
  allowedScopes: string[] | undefined,
): boolean {
  if (articleScopes.length === 0) return true; // unrestricted
  if (allowedScopes?.includes("*")) return true; // admin bypass
  if (!allowedScopes || allowedScopes.length === 0) return false; // no scope access
  return articleScopes.some((s) => allowedScopes.includes(s));
}