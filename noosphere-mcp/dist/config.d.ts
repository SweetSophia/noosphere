export interface ResolvedNoosphereConfig {
    baseUrl: string;
    apiKey?: string;
    timeoutMs: number;
}
export declare class NoosphereConfigError extends Error {
    constructor(message: string);
}
export declare const DEFAULT_NOOSPHERE_BASE_URL = "http://127.0.0.1:6578";
export declare const DEFAULT_NOOSPHERE_TIMEOUT_MS = 5000;
export declare const MIN_NOOSPHERE_TIMEOUT_MS = 500;
export declare const MAX_NOOSPHERE_TIMEOUT_MS = 30000;
type Environment = Record<string, string | undefined>;
export declare function resolveNoosphereConfig(env?: Environment): ResolvedNoosphereConfig;
export {};
//# sourceMappingURL=config.d.ts.map