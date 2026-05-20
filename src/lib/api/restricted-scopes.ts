export type RestrictedTagsResult =
  | { ok: true; value: string[] }
  | { ok: false; status: number; error: string };

export type RestrictedScopeLookup = (tags: string[]) => Promise<Iterable<string>>;

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

  if (!isAdminScope) {
    const unauthorized = requestedTags.filter((tag) => !callerScopes.includes(tag));
    if (unauthorized.length > 0) {
      return {
        ok: false,
        status: 403,
        error: `Cannot assign scope(s) you don't have: ${unauthorized.join(", ")}`,
      };
    }
  }

  return { ok: true, value: requestedTags };
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

export async function validateRestrictedTagsExist(
  tags: string[],
  lookup: RestrictedScopeLookup = findExistingRestrictedScopes,
): Promise<RestrictedTagsResult> {
  if (tags.length === 0) return { ok: true, value: [] };

  const validSet = new Set(await lookup(tags));
  const invalid = tags.filter((tag) => !validSet.has(tag));
  if (invalid.length > 0) {
    return {
      ok: false,
      status: 400,
      error: `Unknown restricted tag(s): ${invalid.join(", ")}`,
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
