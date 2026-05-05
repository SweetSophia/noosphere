import type { ResolvedNoosphereMemoryConfig } from "./config.js";
export interface ToolTextResult {
    content: Array<{
        type: "text";
        text: string;
    }>;
    details?: unknown;
    isError?: boolean;
}
export declare function jsonResult(payload: unknown): ToolTextResult;
export declare function errorResult(error: unknown, config?: ResolvedNoosphereMemoryConfig): ToolTextResult;
export declare function formatError(error: unknown, config?: ResolvedNoosphereMemoryConfig): Record<string, unknown>;
