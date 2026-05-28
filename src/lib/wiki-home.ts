import { buildScopeFilter } from "@/lib/api/auth";

export interface WikiHomeTopic {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  parentId: string | null;
}

export interface WikiHomeTopicCount {
  topicId: string;
  _count: { topicId: number };
}

export interface WikiHomeDb<TArticle> {
  topic: {
    findMany(args: { orderBy: { name: "asc" } }): Promise<WikiHomeTopic[]>;
  };
  article: {
    groupBy(args: {
      by: ["topicId"];
      where: Record<string, unknown>;
      _count: { topicId: true };
    }): Promise<WikiHomeTopicCount[]>;
    findMany(args: {
      where: Record<string, unknown>;
      include: {
        topic: true;
        tags: { include: { tag: true } };
      };
      orderBy: { updatedAt: "desc" };
      take: 8;
    }): Promise<TArticle[]>;
  };
}

export async function loadWikiHomeData<TArticle>(
  db: WikiHomeDb<TArticle>,
  allowedScopes: string[] | undefined,
) {
  const scopeWhere = buildScopeFilter(allowedScopes, { deletedAt: null });

  const [allTopics, topicCounts, recentArticles] = await Promise.all([
    db.topic.findMany({ orderBy: { name: "asc" } }),
    db.article.groupBy({
      by: ["topicId"],
      where: scopeWhere,
      _count: { topicId: true },
    }),
    db.article.findMany({
      where: scopeWhere,
      include: {
        topic: true,
        tags: { include: { tag: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 8,
    }),
  ]);

  return { allTopics, topicCounts, recentArticles };
}
