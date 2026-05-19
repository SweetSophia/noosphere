import type { MemoryRecallResponse, MemorySaveResponse, NoospherePluginConfig, TopicListResponse } from "./types.js";
export interface RecallRequest {
    query: string;
    mode?: "auto" | "inspection";
    resultCap?: number;
    tokenBudget?: number;
    providers?: string[];
    scope?: string;
}
export interface SaveRequest {
    title: string;
    content: string;
    topicId: string;
    excerpt?: string;
    tags?: string[];
    source?: string;
    authorName?: string;
    confidence?: "low" | "medium" | "high";
}
export declare class NoosphereClientError extends Error {
    readonly status?: number | undefined;
    constructor(message: string, status?: number | undefined);
}
export declare class NoosphereClient {
    private readonly config;
    constructor(config: NoospherePluginConfig);
    status(): Promise<unknown>;
    health(): Promise<unknown>;
    topics(): Promise<TopicListResponse>;
    recall(request: RecallRequest): Promise<MemoryRecallResponse>;
    save(request: SaveRequest): Promise<MemorySaveResponse>;
    private requestJson;
}
//# sourceMappingURL=client.d.ts.map