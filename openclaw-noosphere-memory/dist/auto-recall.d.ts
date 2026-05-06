import { NoosphereRecallRequest } from "./client.js";
import { NoosphereClientContext } from "./shared-init.js";
export declare const MAX_QUERY_LENGTH = 1000;
export interface NoosphereAutoRecallConfig {
    autoRecall: boolean;
    autoProviders: string[];
    resultCap: number;
    tokenBudget: number;
    minQueryLength: number;
    recallInjectionPosition: RecallInjectionPosition;
    enabledAgents: string[];
    allowedChatTypes: string[];
    includeRecentTurns: boolean;
    recentTurnLimit: number;
    timeoutMs: number;
    memoryCaptureInstructionsEnabled: boolean;
    memoryCaptureInstructions: string;
    ignoreSessionPatterns: string[];
    statelessSessionPatterns: string[];
    skipStatelessSessions: boolean;
}
export type RecallInjectionPosition = "prepend" | "system-prepend" | "system-append";
export interface NoospherePluginLogger {
    warn?: (message: string) => void;
    info?: (message: string) => void;
    debug?: (message: string) => void;
}
export interface BeforePromptBuildEventLike {
    prompt?: unknown;
    rawMessage?: unknown;
    messages?: unknown[];
}
export interface BeforePromptBuildContextLike {
    agentId?: string;
    messageProvider?: string;
    channelId?: string;
    sessionKey?: string;
    sessionId?: string;
}
export interface PromptInjectionResult {
    prependContext?: string;
    appendSystemContext?: string;
    prependSystemContext?: string;
}
export declare function resolveAutoRecallConfig(rawConfig: unknown): NoosphereAutoRecallConfig;
export declare function createNoosphereAutoRecallHook(rawConfig: unknown, clientContext: NoosphereClientContext, logger?: NoospherePluginLogger): {
    (event: BeforePromptBuildEventLike, ctx?: BeforePromptBuildContextLike): Promise<PromptInjectionResult | void>;
    registrationWarning(): void;
};
/**
 * Build recall query from the event, using rawMessage first (like Hindsight).
 * Strips OpenClaw-specific channel metadata envelopes from the query text.
 */
export declare function buildAutoRecallQuery(event: BeforePromptBuildEventLike, config: NoosphereAutoRecallConfig): string | undefined;
export type AutoRecallRequestForTests = NoosphereRecallRequest;
//# sourceMappingURL=auto-recall.d.ts.map