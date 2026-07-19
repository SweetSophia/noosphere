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
  const access = resolveScopeAccess(allowedScopes);

  // "*" bypasses only restricted-tag filtering. Callers still own deletion,
  // lifecycle, readiness, consent, and every other eligibility predicate.
  if (access.kind === "all") {
    return extraWhere;
  }

  // No scopes at all (undefined or empty): can only access unrestricted articles
  if (access.kind === "unrestricted") {
    if ("restrictedTags" in extraWhere) {
      return {
        AND: [extraWhere, { restrictedTags: { isEmpty: true } }],
      };
    }

    return {
      ...extraWhere,
      restrictedTags: { isEmpty: true },
    };
  }

  // Non-admin key with scopes: unrestricted OR at least one matching scope
  const scopeWhere = {
    OR: [
      { restrictedTags: { isEmpty: true } },
      { restrictedTags: { hasSome: access.scopes } },
    ],
  };

  if ("OR" in extraWhere || "restrictedTags" in extraWhere) {
    return {
      AND: [extraWhere, scopeWhere],
    };
  }

  return {
    ...extraWhere,
    ...scopeWhere,
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
  const access = resolveScopeAccess(allowedScopes);
  if (access.kind === "all") return true;
  if (access.kind === "unrestricted") return false;
  return articleScopes.some((scope) => access.scopes.includes(scope));
}

export type ResolvedScopeAccess =
  | { kind: "all" }
  | { kind: "unrestricted" }
  | { kind: "scoped"; scopes: string[] };

/**
 * Canonical scope interpretation shared by the in-memory predicate, Prisma
 * filter, and parameterized raw-SQL adapter.
 */
export function resolveScopeAccess(
  allowedScopes: string[] | undefined,
): ResolvedScopeAccess {
  if (allowedScopes?.includes("*")) return { kind: "all" };
  if (!allowedScopes || allowedScopes.length === 0) {
    return { kind: "unrestricted" };
  }
  return { kind: "scoped", scopes: [...new Set(allowedScopes)] };
}
