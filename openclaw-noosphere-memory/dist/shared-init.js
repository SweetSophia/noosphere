import { NoosphereMemoryClient } from "./client.js";
import { resolveNoosphereMemoryConfig, } from "./config.js";
export function createNoosphereClientContext(rawConfig, rootConfig) {
    const config = resolveNoosphereMemoryConfig(rawConfig, process.env, rootConfig);
    return { config, client: new NoosphereMemoryClient(config) };
}
//# sourceMappingURL=shared-init.js.map