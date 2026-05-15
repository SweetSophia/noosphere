export interface NoosphereMemoryConfig {
    baseUrl?: string;
    /** Single API key (string or secret ref) used as default for all agents. */
    apiKey?: string | {
        value?: string;
    } | SecretRefInput;
    /**
     * Per-agent API key map. Agent IDs are keys, API keys are values.
     * Takes precedence over `apiKey` for matching agents.
     * Example: { "shodan": "noo_abc...", "cylena": "noo_xyz..." }
     */
    apiKeys?: Record<string, string>;
    timeoutMs?: number;
}
interface SecretRefInput {
    source?: unknown;
    provider?: unknown;
    id?: unknown;
}
export interface ResolvedNoosphereMemoryConfig {
    baseUrl: string;
    /** Resolved default API key (fallback when no per-agent key matches). */
    apiKey?: string;
    /** Per-agent API key map (from config.apiKeys, not resolved from secrets). */
    apiKeys?: Record<string, string>;
    timeoutMs: number;
}
export declare const DEFAULT_NOOSPHERE_BASE_URL = "http://localhost:3000";
export declare const DEFAULT_NOOSPHERE_TIMEOUT_MS = 5000;
export declare const MAX_NOOSPHERE_TIMEOUT_MS = 30000;
export declare const DEFAULT_AUTO_RECALL_TIMEOUT_MS = 1500;
export declare const MAX_AUTO_RECALL_TIMEOUT_MS = 5000;
export declare function resolveNoosphereMemoryConfig(rawConfig: unknown, env?: NodeJS.ProcessEnv, rootConfig?: unknown): ResolvedNoosphereMemoryConfig;
/**
 * Resolve the API key for a specific agent.
 * Priority:
 *   1. NOOSPHERE_API_KEY_<AGENT_ID> env var (e.g. NOOSPHERE_API_KEY_SHODAN)
 *   2. apiKeys[agentId] from plugin config (plain text, for multi-agent setups)
 *   3. Default apiKey (resolved from string, secret ref, or env.NOOSPHERE_API_KEY)
 */
export declare function resolveApiKeyForAgent(rawConfig: unknown, env?: NodeJS.ProcessEnv, rootConfig?: unknown, agentId?: string): string | undefined;
export declare function redactSecret(value: string | undefined): string | undefined;
export declare function readString(value: unknown): string | undefined;
export declare function readNumber(value: unknown): number | undefined;
export declare function clampTimeout(value: unknown, fallback: number, max?: number): number;
export declare function readBoolean(value: unknown): boolean | undefined;
export declare function readStringArray(value: unknown): string[] | undefined;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export {};
//# sourceMappingURL=config.d.ts.map