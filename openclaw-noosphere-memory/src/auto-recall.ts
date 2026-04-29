import { NoosphereRecallRequest, NoosphereRecallResponse } from "./client.js";
import {
  isRecord,
  readBoolean,
  readNumber,
  readString,
  readStringArray,
  ResolvedNoosphereMemoryConfig,
} from "./config.js";
import { NoosphereClientContext } from "./shared-init.js";

const DEFAULT_AUTO_PROVIDERS = ["noosphere"];
const DEFAULT_RESULT_CAP = 5;
const DEFAULT_TOKEN_BUDGET = 1_200;
const DEFAULT_MIN_QUERY_LENGTH = 8;
const MAX_RESULT_CAP = 10;
const MAX_TOKEN_BUDGET = 2_000;
const MAX_QUERY_LENGTH = 1_000;

export interface NoosphereAutoRecallConfig {
  autoRecall: boolean;
  autoProviders: string[];
  resultCap: number;
  tokenBudget: number;
  minQueryLength: number;
  enabledAgents: string[];
  allowedChatTypes: string[];
  includeRecentTurns: boolean;
  recentTurnLimit: number;
}

export interface NoospherePluginLogger {
  warn?: (message: string) => void;
  info?: (message: string) => void;
  debug?: (message: string) => void;
}

export interface BeforePromptBuildEventLike {
  prompt?: unknown;
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
}

export function resolveAutoRecallConfig(rawConfig: unknown): NoosphereAutoRecallConfig {
  const config = isRecord(rawConfig) ? rawConfig : {};
  const autoRecallRaw = config.autoRecall;

  return {
    autoRecall: readBoolean(autoRecallRaw) ?? false,
    autoProviders: readStringArray(config.autoProviders) ?? DEFAULT_AUTO_PROVIDERS,
    resultCap: clampNumber(config.maxInjectedMemories ?? config.resultCap, 1, MAX_RESULT_CAP, DEFAULT_RESULT_CAP),
    tokenBudget: clampNumber(config.maxInjectedTokens ?? config.tokenBudget, 1, MAX_TOKEN_BUDGET, DEFAULT_TOKEN_BUDGET),
    minQueryLength: clampNumber(config.minQueryLength, 1, MAX_QUERY_LENGTH, DEFAULT_MIN_QUERY_LENGTH),
    enabledAgents: readStringArray(config.enabledAgents) ?? [],
    allowedChatTypes: readStringArray(config.allowedChatTypes) ?? [],
    includeRecentTurns: readBoolean(config.includeRecentTurns) ?? true,
    recentTurnLimit: clampNumber(config.recentTurnLimit, 0, 10, 4),
  };
}

export function createNoosphereAutoRecallHook(
  rawConfig: unknown,
  clientContext: NoosphereClientContext,
  logger?: NoospherePluginLogger,
) {
  const autoConfig = resolveAutoRecallConfig(rawConfig);

  return async (
    event: BeforePromptBuildEventLike,
    ctx: BeforePromptBuildContextLike = {},
  ): Promise<PromptInjectionResult | void> => {
    if (!shouldAutoRecall(autoConfig, event, ctx, clientContext.config)) return;

    const query = buildAutoRecallQuery(event, autoConfig);
    if (!query || query.length < autoConfig.minQueryLength) return;

    try {
      const response = await clientContext.client.recall({
        query,
        mode: "auto",
        resultCap: autoConfig.resultCap,
        tokenBudget: autoConfig.tokenBudget,
        providers: autoConfig.autoProviders,
      });
      const promptText = extractPromptInjectionText(response);
      if (!promptText) return;
      return { prependContext: promptText };
    } catch (error) {
      logger?.warn?.(`noosphere-memory: auto-recall skipped: ${formatHookError(error)}`);
      return;
    }
  };
}

export function buildAutoRecallQuery(event: BeforePromptBuildEventLike, config: NoosphereAutoRecallConfig): string | undefined {
  const prompt = readString(event.prompt);
  if (!prompt) return undefined;

  const parts = [prompt];
  if (config.includeRecentTurns && Array.isArray(event.messages) && config.recentTurnLimit > 0) {
    const recentTurns = extractRecentUserTurns(event.messages, config.recentTurnLimit)
      .filter((turn) => turn && turn !== prompt);
    if (recentTurns.length > 0) {
      parts.unshift(...recentTurns);
    }
  }

  return parts.join("\n\n").slice(0, MAX_QUERY_LENGTH);
}

function shouldAutoRecall(
  config: NoosphereAutoRecallConfig,
  event: BeforePromptBuildEventLike,
  ctx: BeforePromptBuildContextLike,
  resolvedConfig: ResolvedNoosphereMemoryConfig,
): boolean {
  if (!config.autoRecall) return false;
  if (!resolvedConfig.apiKey) return false;
  if (!readString(event.prompt)) return false;

  if (config.enabledAgents.length > 0 && !matchesAny(config.enabledAgents, ctx.agentId)) return false;
  if (config.allowedChatTypes.length > 0 && !matchesAny(config.allowedChatTypes, resolveChatType(ctx))) return false;

  return true;
}

function extractPromptInjectionText(response: NoosphereRecallResponse): string | undefined {
  if (typeof response.promptInjectionText !== "string") return undefined;
  const trimmed = response.promptInjectionText.trim();
  return trimmed ? trimmed : undefined;
}

function extractRecentUserTurns(messages: unknown[], limit: number): string[] {
  const turns: string[] = [];
  for (let index = messages.length - 1; index >= 0 && turns.length < limit; index -= 1) {
    const message = messages[index];
    if (!isRecord(message)) continue;
    const role = readString(message.role);
    if (role && role !== "user") continue;
    const text = extractMessageText(message.content);
    if (text) turns.push(text);
  }
  return turns.reverse();
}

function extractMessageText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        if (typeof item === "string") return item;
        if (isRecord(item) && typeof item.text === "string") return item.text;
        return undefined;
      })
      .filter((item): item is string => !!item && !!item.trim())
      .join("\n");
    return text.trim() || undefined;
  }
  if (isRecord(content) && typeof content.text === "string") return content.text.trim() || undefined;
  return undefined;
}

function resolveChatType(ctx: BeforePromptBuildContextLike): string | undefined {
  return readString(ctx.messageProvider) ?? readString(ctx.channelId);
}

function matchesAny(allowed: string[], value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return allowed.some((entry) => entry.toLowerCase() === normalized);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = readNumber(value);
  if (parsed === undefined) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function formatHookError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type AutoRecallRequestForTests = NoosphereRecallRequest;
