import { canAccessScopes } from "@/lib/api/scope-filter";

interface ArticleRelationWriter {
  articleRelation: {
    deleteMany: (args: { where: { sourceId: string } }) => Promise<unknown>;
    createMany: (args: {
      data: Array<{ sourceId: string; targetId: string }>;
      skipDuplicates: true;
    }) => Promise<unknown>;
  };
}

export interface ArticleRelationReader {
  article: {
    findMany: (args: {
      where: { id: { in: string[] }; deletedAt: null };
      select: { id: true; restrictedTags: true };
    }) => Promise<Array<{ id: string; restrictedTags: string[] }>>;
  };
}

export async function syncArticleRelations(
  tx: ArticleRelationWriter,
  sourceId: string,
  relatedArticleIds: string[] | undefined,
) {
  if (relatedArticleIds === undefined) {
    return;
  }

  await tx.articleRelation.deleteMany({ where: { sourceId } });

  const relationRows = Array.from(new Set(relatedArticleIds))
    .filter((targetId) => targetId !== sourceId)
    .map((targetId) => ({ sourceId, targetId }));

  if (relationRows.length > 0) {
    await tx.articleRelation.createMany({
      data: relationRows,
      skipDuplicates: true,
    });
  }
}

/**
 * Filter candidate related-article IDs down to those the caller is
 * allowed to link. A target is kept only if it (a) exists, (b) is not
 * soft-deleted, and (c) the caller's allowedScopes can see its
 * restrictedTags. Inaccessible candidates are silently dropped — the
 * response never reveals whether an ID was invalid vs. merely
 * restricted. Duplicates in the input are de-duplicated.
 */
export async function filterAccessibleRelatedTargets(
  reader: ArticleRelationReader,
  candidateIds: string[],
  allowedScopes: string[] | undefined,
): Promise<string[]> {
  const unique = Array.from(new Set(candidateIds));
  if (unique.length === 0) {
    return [];
  }

  const existing = await reader.article.findMany({
    where: { id: { in: unique }, deletedAt: null },
    select: { id: true, restrictedTags: true },
  });

  return existing
    .filter((article) => canAccessScopes(article.restrictedTags, allowedScopes))
    .map((article) => article.id);
}
