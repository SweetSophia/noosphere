export interface NoosphereClientConfig {
    baseUrl: string;
    apiKey?: string;
    timeoutMs: number;
}
export interface SearchArticlesInput {
    query?: string;
    topic?: string;
    tag?: string;
    status?: "draft" | "reviewed" | "published";
    confidence?: "low" | "medium" | "high";
    page?: number;
    limit?: number;
}
export type GetArticleInput = {
    articleId: string;
    canonicalRef?: never;
} | {
    canonicalRef: string;
    articleId?: never;
};
export interface SaveMemoryInput {
    title: string;
    content: string;
    topicId: string;
    excerpt?: string;
    tags?: string[];
    source?: string;
    authorName?: string;
    confidence?: "low" | "medium" | "high";
    restrictedTags?: string[];
}
export interface RecallMemoryInput {
    query: string;
    resultCap?: number;
    tokenBudget?: number;
    scope?: string;
    providers?: string[];
}
export interface CreateArticleInput {
    title: string;
    slug: string;
    content: string;
    topicId: string;
    excerpt?: string;
    tags?: string[];
    authorName?: string;
    confidence?: "low" | "medium" | "high";
    status?: "draft" | "reviewed" | "published";
    relatedArticleIds?: string[];
    restrictedTags?: string[];
}
export type NoosphereResponse = Record<string, unknown>;
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export declare class NoosphereClientError extends Error {
    readonly status?: number | undefined;
    constructor(message: string, status?: number | undefined);
}
export declare class NoosphereClient {
    private readonly config;
    private readonly fetchFn;
    constructor(config: NoosphereClientConfig, fetchFn?: FetchLike);
    searchArticles(input: SearchArticlesInput): Promise<NoosphereResponse>;
    getArticle(input: GetArticleInput): Promise<NoosphereResponse>;
    saveMemory(input: SaveMemoryInput): Promise<NoosphereResponse>;
    recallMemory(input: RecallMemoryInput): Promise<NoosphereResponse>;
    createArticle(input: CreateArticleInput): Promise<NoosphereResponse>;
    private postJson;
    private request;
}
//# sourceMappingURL=client.d.ts.map