interface ArticleRelationWriter {
  articleRelation: {
    deleteMany: (args: { where: { sourceId: string } }) => Promise<unknown>;
    createMany: (args: {
      data: Array<{ sourceId: string; targetId: string }>;
      skipDuplicates: true;
    }) => Promise<unknown>;
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

  const relationRows = relatedArticleIds
    .filter((targetId) => targetId !== sourceId)
    .map((targetId) => ({ sourceId, targetId }));

  if (relationRows.length > 0) {
    await tx.articleRelation.createMany({
      data: relationRows,
      skipDuplicates: true,
    });
  }
}
