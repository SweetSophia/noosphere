export interface NoosphereMemoryConfig {
    baseUrl?: string;
    apiKey?: string | {
        value?: string;
    } | SecretRefInput;
    timeoutMs?: number;
}
interface SecretRefInput {
    source?: unknown;
    provider?: unknown;
    id?: unknown;
}
export interface ResolvedNoosphereMemoryConfig {
    baseUrl: string;
    apiKey?: string;
    timeoutMs: number;
}
export declare const DEFAULT_NOOSPHERE_BASE_URL = "http://localhost:3000";
export declare const DEFAULT_NOOSPHERE_TIMEOUT_MS = 5000;
export declare const MAX_NOOSPHERE_TIMEOUT_MS = 30000;
export declare const DEFAULT_AUTO_RECALL_TIMEOUT_MS = 1500;
export declare const MAX_AUTO_RECALL_TIMEOUT_MS = 5000;
export declare function resolveNoosphereMemoryConfig(rawConfig: unknown, env?: NodeJS.ProcessEnv, rootConfig?: unknown): ResolvedNoosphereMemoryConfig;
export declare function redactSecret(value: string | undefined): string | undefined;
export declare function readString(value: unknown): string | undefined;
export declare function readNumber(value: unknown): number | undefined;
export declare function clampTimeout(value: unknown, fallback: number, max?: number): number;
export declare function readBoolean(value: unknown): boolean | undefined;
export declare function readStringArray(value: unknown): string[] | undefined;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export {};
