import { ResolvedNoosphereMemoryConfig } from "./config.js";
import { NoosphereMemoryGetProviderMeta, NoosphereMemoryResult } from "./types.js";
export interface NoosphereSettingsResponse {
    autoRecallEnabled: boolean;
    maxInjectedMemories: number;
    maxInjectedTokens: number;
    recallVerbosity: string;
    deduplicationStrategy: string;
    enabledProviders: string[];
    providerPriorityWeights: Record<string, number>;
    summaryFirst: boolean;
    conflictStrategy: string;
    conflictThreshold: number;
}
export interface NoosphereStatusResponse {
    ok: boolean;
    timestamp: string;
    providers: unknown[];
    settings: Record<string, unknown>;
}
export interface NoosphereRecallRequest {
    query: string;
    mode?: "auto" | "inspection";
    resultCap?: number;
    tokenBudget?: number;
    scope?: string;
    providers?: string[];
}
export interface NoosphereSaveRequest {
    title: string;
    content: string;
    topicId: string;
    excerpt?: string;
    tags?: string[];
    source?: string;
    authorName?: string;
    confidence?: "low" | "medium" | "high";
}
export type NoosphereGetRequest = {
    canonicalRef: string;
    provider?: never;
    id?: never;
} | {
    provider: string;
    id: string;
    canonicalRef?: never;
};
export interface NoosphereGetResponse {
    result: NoosphereMemoryResult | null;
    providerMeta: NoosphereMemoryGetProviderMeta[];
}
export interface NoosphereSaveResponse {
    success: true;
    candidate: {
        id: string;
        title: string;
        slug: string;
        topicId: string;
        topic?: {
            id: string;
            name: string;
            slug: string;
        };
        status: "draft";
        url?: string;
    };
    strippedBlocks: string[];
}
export interface NoosphereRecallResponse {
    results: unknown[];
    totalBeforeCap: number;
    mode: "auto" | "inspection";
    tokenBudgetUsed?: number;
    promptInjectionText?: string;
    providerMeta: unknown[];
    dedupStats?: unknown;
    conflicts?: unknown[];
    conflictStats?: unknown;
}
export declare class NoosphereClientError extends Error {
    readonly status?: number | undefined;
    readonly details?: unknown | undefined;
    constructor(message: string, status?: number | undefined, details?: unknown | undefined);
}
export declare class NoosphereMemoryClient {
    private readonly config;
    constructor(config: ResolvedNoosphereMemoryConfig);
    status(): Promise<NoosphereStatusResponse>;
    settings(): Promise<NoosphereSettingsResponse>;
    get(request: NoosphereGetRequest): Promise<NoosphereGetResponse>;
    save(request: NoosphereSaveRequest): Promise<NoosphereSaveResponse>;
    recall(request: NoosphereRecallRequest, options?: {
        timeoutMs?: number;
    }): Promise<NoosphereRecallResponse>;
    private request;
}
