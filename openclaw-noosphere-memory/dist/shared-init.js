import { NoosphereMemoryClient } from "./client.js";
import { resolveNoosphereMemoryConfig, resolveApiKeyForAgent, } from "./config.js";
/**
 * Creates a client context using the default/global API key.
 * Used for pre-startup validation and plugin initialization.
 */
export function createNoosphereClientContext(rawConfig, rootConfig) {
    const config = resolveNoosphereMemoryConfig(rawConfig, process.env, rootConfig);
    const resolvedKey = resolveApiKeyForAgent(rawConfig, process.env, rootConfig, undefined);
    const effectiveConfig = { ...config, apiKey: resolvedKey };
    return { config: effectiveConfig, client: new NoosphereMemoryClient(effectiveConfig) };
}
/**
 * Creates a client context for a specific agent, using that agent's API key
 * if configured. Falls back to the default key if no per-agent key exists.
 */
export function createNoosphereClientContextForAgent(rawConfig, agentId, rootConfig) {
    const config = resolveNoosphereMemoryConfig(rawConfig, process.env, rootConfig);
    const resolvedKey = resolveApiKeyForAgent(rawConfig, process.env, rootConfig, agentId);
    const effectiveConfig = { ...config, apiKey: resolvedKey };
    return { config: effectiveConfig, client: new NoosphereMemoryClient(effectiveConfig) };
}
//# sourceMappingURL=shared-init.js.map