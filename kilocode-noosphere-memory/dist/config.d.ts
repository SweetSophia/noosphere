import type { PluginOptions } from "@kilocode/plugin";
import type { NoospherePluginConfig } from "./types.js";
export declare function resolveConfig(options: PluginOptions | undefined, env?: NodeJS.ProcessEnv): NoospherePluginConfig;
export declare function redactSecret(value: string | undefined): string | undefined;
//# sourceMappingURL=config.d.ts.map