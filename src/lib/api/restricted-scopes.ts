export type RestrictedTagsResult =
  | { ok: true; value: string[] }
  | { ok: false; status: number; error: string };

export type RestrictedScopeLookup = (tags: string[]) => Promise<Iterable<string>>;

type UnknownRestrictedTagsError = (
  invalidTags: string[],
  validTags: string[],
) => string;

function authorizeRestrictedTags(
  tags: string[],
  allowedScopes: string[] | undefined,
): RestrictedTagsResult {
  const callerScopes = allowedScopes ?? [];
  if (callerScopes.includes("*")) {
    return { ok: true, value: tags };
  }

  const unauthorized = tags.filter((tag) => !callerScopes.includes(tag));
  if (unauthorized.length > 0) {
    return {
      ok: false,
      status: 403,
      error: `Cannot assign scope(s) you don't have: ${unauthorized.join(", ")}`,
    };
  }

  return { ok: true, value: tags };
}

export function normalizeRestrictedTagsForCaller(
  value: unknown,
  allowedScopes: string[] | undefined,
): RestrictedTagsResult {
  const callerScopes = allowedScopes ?? [];
  const isAdminScope = callerScopes.includes("*");
  let requestedTags: string[] = [];

  if (value !== undefined && value !== null) {
    if (!Array.isArray(value)) {
      return {
        ok: false,
        status: 400,
        error: "restrictedTags must be an array of non-empty strings",
      };
    }

    const seen = new Set<string>();
    for (const item of value) {
      if (typeof item !== "string" || !item.trim()) {
        return {
          ok: false,
          status: 400,
          error: "restrictedTags must be an array of non-empty strings",
        };
      }
      const tag = item.trim();
      if (!seen.has(tag)) {
        seen.add(tag);
        requestedTags.push(tag);
      }
    }
  }

  if (!isAdminScope && callerScopes.length > 0 && requestedTags.length === 0) {
    requestedTags = [...callerScopes];
  }

  return authorizeRestrictedTags(requestedTags, allowedScopes);
}

export async function resolveRestrictedTagsForCaller(
  value: unknown,
  allowedScopes: string[] | undefined,
  lookup: RestrictedScopeLookup = findExistingRestrictedScopes,
): Promise<RestrictedTagsResult> {
  const normalized = normalizeRestrictedTagsForCaller(value, allowedScopes);
  if (!normalized.ok) return normalized;

  return validateRestrictedTagsExist(normalized.value, lookup);
}

/**
 * Validates restrictedTags coming from a markdown import file.
 *
 * Unlike `resolveRestrictedTagsForCaller` (used by POST /api/articles), this
 * does NOT default missing tags to the caller's scopes. Import files must
 * explicitly declare their restricted tags; an omitted/empty value means
 * "no restricted tags" regardless of the caller's scopes.
 *
 * Otherwise, scope assignment and existence checks are identical.
 *
 * Design note: a flag parameter on `resolveRestrictedTagsForCaller` was
 * considered and rejected. The two callers have different contracts
 * (auto-assign vs. explicit) and conflating them behind a boolean makes
 * both call sites harder to read. A named function keeps each contract
 * visible at the call site.
 */
export async function resolveImportRestrictedTags(
  value: unknown,
  allowedScopes: string[] | undefined,
  lookup: RestrictedScopeLookup = findExistingRestrictedScopes,
): Promise<RestrictedTagsResult> {
  if (value === undefined || value === null) {
    return { ok: true, value: [] };
  }
  if (Array.isArray(value) && value.length === 0) {
    return { ok: true, value: [] };
  }
  return resolveRestrictedTagsForCaller(value, allowedScopes, lookup);
}

/**
 * Validates restrictedTags on PATCH /api/articles/[id].
 *
 * PATCH only calls this helper when the field is present. Its input and error
 * behavior intentionally match the previous inline route validation: null and
 * non-array values are rejected, whitespace and duplicates are not normalized,
 * and unknown-tag errors retain their legacy response text. The sensitive
 * scope-membership check is shared with the create/import paths.
 */
export async function resolvePatchRestrictedTags(
  value: unknown,
  allowedScopes: string[] | undefined,
  lookup: RestrictedScopeLookup = findExistingRestrictedScopes,
): Promise<RestrictedTagsResult> {
  if (
    !Array.isArray(value) ||
    !value.every((tag) => typeof tag === "string" && tag.length > 0)
  ) {
    return {
      ok: false,
      status: 400,
      error: "restrictedTags must be an array of non-empty strings",
    };
  }

  const existing = await validateRestrictedTagsExist(
    value,
    lookup,
    (invalidTags, validTags) =>
      `Unknown restricted tag(s): ${invalidTags.join(", ")}. Valid tags: ${validTags.join(", ")}`,
  );
  if (!existing.ok) return existing;

  return authorizeRestrictedTags(existing.value, allowedScopes);
}

export async function validateRestrictedTagsExist(
  tags: string[],
  lookup: RestrictedScopeLookup = findExistingRestrictedScopes,
  formatError: UnknownRestrictedTagsError = (invalidTags) =>
    `Unknown restricted tag(s): ${invalidTags.join(", ")}`,
): Promise<RestrictedTagsResult> {
  if (tags.length === 0) return { ok: true, value: [] };

  const validTags = Array.from(await lookup(tags));
  const validSet = new Set(validTags);
  const invalid = tags.filter((tag) => !validSet.has(tag));
  if (invalid.length > 0) {
    return {
      ok: false,
      status: 400,
      error: formatError(invalid, validTags),
    };
  }

  return { ok: true, value: tags };
}

async function findExistingRestrictedScopes(tags: string[]): Promise<string[]> {
  const { prisma } = await import("@/lib/prisma");
  const scopes = await prisma.restrictedScope.findMany({
    where: { tag: { in: tags } },
    select: { tag: true },
  });
  return scopes.map((scope) => scope.tag);
}
