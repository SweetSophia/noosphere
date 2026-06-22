declare const INJECTED_MEMORY_BLOCKS: readonly ["recall", "hindsight_memories", "noosphere_auto_recall"];
export type InjectedMemoryBlock = (typeof INJECTED_MEMORY_BLOCKS)[number];
export type InjectedMemoryStripMode = "openclaw-article-create" | "server-save";
export declare const OPENCLAW_ARTICLE_CREATE_STRIP_MODE: "openclaw-article-create";
export declare const SERVER_MEMORY_SAVE_STRIP_MODE: "server-save";
export declare function stripInjectedMemoryBlocks(content: string, mode: InjectedMemoryStripMode): {
    content: string;
    strippedBlocks: string[];
};
export {};
//# sourceMappingURL=index.d.ts.map