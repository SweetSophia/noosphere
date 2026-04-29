import { NoosphereMemoryClient } from "./client.js";
import { resolveNoosphereMemoryConfig } from "./config.js";

export interface NoospherePluginRuntimeLike {
  pluginConfig?: unknown;
}

export function createNoosphereClient(api: NoospherePluginRuntimeLike): NoosphereMemoryClient {
  return new NoosphereMemoryClient(resolveNoosphereMemoryConfig(api.pluginConfig));
}
