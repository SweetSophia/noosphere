import { NoosphereMemoryClient } from "./client.js";
import {
  resolveNoosphereMemoryConfig,
  type ResolvedNoosphereMemoryConfig,
} from "./config.js";

export interface NoosphereClientContext {
  config: ResolvedNoosphereMemoryConfig;
  client: NoosphereMemoryClient;
}

export function createNoosphereClientContext(rawConfig: unknown, rootConfig?: unknown): NoosphereClientContext {
  const config = resolveNoosphereMemoryConfig(rawConfig, process.env, rootConfig);
  return { config, client: new NoosphereMemoryClient(config) };
}
