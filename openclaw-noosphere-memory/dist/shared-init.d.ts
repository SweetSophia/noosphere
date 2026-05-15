import { NoosphereMemoryClient } from "./client.js";
import { type ResolvedNoosphereMemoryConfig } from "./config.js";
export interface NoosphereClientContext {
    config: ResolvedNoosphereMemoryConfig;
    client: NoosphereMemoryClient;
}
/**
 * Creates a client context using the default/global API key.
 * Used for pre-startup validation and plugin initialization.
 */
export declare function createNoosphereClientContext(rawConfig: unknown, rootConfig?: unknown): NoosphereClientContext;
/**
 * Creates a client context for a specific agent, using that agent's API key
 * if configured. Falls back to the default key if no per-agent key exists.
 */
export declare function createNoosphereClientContextForAgent(rawConfig: unknown, agentId: string, rootConfig?: unknown): NoosphereClientContext;
//# sourceMappingURL=shared-init.d.ts.map