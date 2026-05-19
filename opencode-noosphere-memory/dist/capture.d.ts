import type { PluginInput } from "@opencode-ai/plugin";
import type { NoosphereClient } from "./client.js";
import type { NoospherePluginConfig } from "./types.js";
export declare function savePrompt(sessionId: string, messageId: string, content: string): void;
export declare function clearSessionPrompts(sessionId: string): void;
/**
 * Marks a session as having an in-flight auto-save.
 * Returns `true` if the session was NOT already pending (caller should proceed);
 * returns `false` if a save is already in-flight (caller should skip).
 */
export declare function markPendingCapture(sessionId: string): boolean;
/**
 * Clears the in-flight flag for a session.  Call from `finally` after
 * `performAutoCapture` completes (success or failure).
 */
export declare function clearPendingCapture(sessionId: string): void;
export declare function performAutoCapture(ctx: PluginInput, client: NoosphereClient, config: NoospherePluginConfig, sessionId: string): Promise<void>;
//# sourceMappingURL=capture.d.ts.map