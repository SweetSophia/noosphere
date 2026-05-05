import type { NoosphereClientContext } from "./shared-init.js";
export interface CorpusSupplementLogger {
    warn?: (message: string) => void;
}
export interface MemoryCorpusSearchResult {
    corpus: string;
    path: string;
    title?: string;
    kind?: string;
    score: number;
    snippet: string;
    id?: string;
    citation?: string;
    source?: string;
    provenanceLabel?: string;
    sourceType?: string;
    sourcePath?: string;
    updatedAt?: string;
}
export interface MemoryCorpusGetResult {
    corpus: string;
    path: string;
    title?: string;
    kind?: string;
    content: string;
    fromLine: number;
    lineCount: number;
    id?: string;
    provenanceLabel?: string;
    sourceType?: string;
    sourcePath?: string;
    updatedAt?: string;
}
export interface MemoryCorpusSupplement {
    search(params: {
        query: string;
        maxResults?: number;
    }): Promise<MemoryCorpusSearchResult[]>;
    get(params: {
        lookup: string;
        fromLine?: number;
        lineCount?: number;
    }): Promise<MemoryCorpusGetResult | null>;
}
export declare function createNoosphereCorpusSupplement(context: NoosphereClientContext, logger?: CorpusSupplementLogger): MemoryCorpusSupplement;
