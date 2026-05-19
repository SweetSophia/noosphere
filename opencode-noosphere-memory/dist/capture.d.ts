import type { PluginInput } from "@opencode-ai/plugin";
import type { NoosphereClient } from "./client.js";
import type { NoospherePluginConfig } from "./types.js";
export declare function savePrompt(sessionId: string, messageId: string, content: string): void;
export declare function clearSessionPrompts(sessionId: string): void;
export declare function performAutoCapture(ctx: PluginInput, client: NoosphereClient, config: NoospherePluginConfig, sessionId: string): Promise<void>;
//# sourceMappingURL=capture.d.ts.map