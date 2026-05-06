import { NoosphereMemoryClient } from "./client.js";
import { type ResolvedNoosphereMemoryConfig } from "./config.js";
export interface NoosphereClientContext {
    config: ResolvedNoosphereMemoryConfig;
    client: NoosphereMemoryClient;
}
export declare function createNoosphereClientContext(rawConfig: unknown, rootConfig?: unknown): NoosphereClientContext;
//# sourceMappingURL=shared-init.d.ts.map