import type { PluginInput } from "@opencode-ai/plugin";
import type { NoosphereClient } from "./client.js";
import type { NoospherePluginConfig, SessionPrompt } from "./types.js";
import { truncate } from "./format.js";

const promptsBySession = new Map<string, SessionPrompt[]>();
const capturedMessageIdsBySession = new Map<string, Set<string>>();
const MAX_PROMPTS_PER_SESSION = 100;
const MIN_CAPTURE_LENGTH = 80;
const TRIVIAL_PROMPT_RE =
  /^(ok|okay|thanks?|thank you|done|yes|no|sure|nice|cool|great|got it)[.!?\s]*$/i;

export function savePrompt(sessionId: string, messageId: string, content: string): void {
  const prompts = promptsBySession.get(sessionId) ?? [];
  prompts.push({ messageId, content, timestamp: Date.now() });
  if (prompts.length > MAX_PROMPTS_PER_SESSION) prompts.shift();
  promptsBySession.set(sessionId, prompts);
  pruneCapturedMessageIds(sessionId, prompts);
}

export function clearSessionPrompts(sessionId: string): void {
  promptsBySession.delete(sessionId);
  capturedMessageIdsBySession.delete(sessionId);
}

export async function performAutoCapture(
  ctx: PluginInput,
  client: NoosphereClient,
  config: NoospherePluginConfig,
  sessionId: string,
): Promise<void> {
  if (!config.autoSaveTopicId) return;
  const prompt = getLastUncapturedPrompt(sessionId);
  if (!prompt || shouldSkipPrompt(prompt.content)) return;

  const messagesResponse = await ctx.client.session.messages({
    path: { id: sessionId },
  });
  const messages = messagesResponse.data ?? [];
  const promptIndex = messages.findIndex((message) => message.info?.id === prompt.messageId);
  if (promptIndex === -1) return;

  const aiMessages = messages.slice(promptIndex + 1).filter((message) => message.info?.role === "assistant");
  const textResponses = extractAssistantText(aiMessages);
  const toolCalls = extractToolCalls(aiMessages);
  if (textResponses.length === 0 && toolCalls.length === 0) return;

  const userRequest = truncate(prompt.content.trim(), 1_500);
  const aiResponse = truncate(textResponses.join("\n\n"), 4_000);
  const title = `Opencode: ${truncate(firstLine(userRequest), 100)}`;
  const content = [
    "## User Request",
    userRequest,
    "",
    aiResponse ? "## Assistant Response" : "",
    aiResponse,
    "",
    toolCalls.length > 0 ? "## Tools Used" : "",
    ...toolCalls.map((toolCall) => `- ${toolCall}`),
    "",
    "## Session",
    `- Session: ${sessionId}`,
    `- Captured: ${new Date().toISOString()}`,
  ].filter(Boolean).join("\n");

  if (content.length < MIN_CAPTURE_LENGTH) return;

  await client.save({
    title,
    content,
    topicId: config.autoSaveTopicId,
    excerpt: firstLine(userRequest),
    tags: ["opencode", "auto-capture"],
    source: `opencode:${sessionId}:${prompt.messageId}`,
    authorName: config.authorName,
    confidence: "medium",
  });
  markPromptCaptured(sessionId, prompt.messageId);
}

function getLastUncapturedPrompt(sessionId: string): SessionPrompt | undefined {
  const prompts = promptsBySession.get(sessionId) ?? [];
  for (let index = prompts.length - 1; index >= 0; index -= 1) {
    const prompt = prompts[index];
    if (prompt && !isPromptCaptured(sessionId, prompt.messageId)) return prompt;
  }
  return undefined;
}

function isPromptCaptured(sessionId: string, messageId: string): boolean {
  return capturedMessageIdsBySession.get(sessionId)?.has(messageId) ?? false;
}

function markPromptCaptured(sessionId: string, messageId: string): void {
  const capturedMessageIds = capturedMessageIdsBySession.get(sessionId) ?? new Set<string>();
  capturedMessageIds.add(messageId);
  capturedMessageIdsBySession.set(sessionId, capturedMessageIds);
}

function pruneCapturedMessageIds(sessionId: string, prompts: SessionPrompt[]): void {
  const capturedMessageIds = capturedMessageIdsBySession.get(sessionId);
  if (!capturedMessageIds) return;

  const retainedMessageIds = new Set(prompts.map((prompt) => prompt.messageId));
  for (const messageId of capturedMessageIds) {
    if (!retainedMessageIds.has(messageId)) capturedMessageIds.delete(messageId);
  }

  if (capturedMessageIds.size === 0) capturedMessageIdsBySession.delete(sessionId);
}

function shouldSkipPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  // Skip very short prompts (below minimum capture length)
  if (trimmed.length < MIN_CAPTURE_LENGTH) return true;
  // CodeQL js/polynomial-redos: skip regex on very long inputs to avoid
  // catastrophic backtracking on adversarial content with many repeated chars
  if (trimmed.length > 200) return false;
  return TRIVIAL_PROMPT_RE.test(trimmed);
}

function extractAssistantText(messages: Array<{ parts?: unknown[] }>): string[] {
  const text: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
        const value = part.text.trim();
        if (value) text.push(value);
      }
    }
  }
  return text;
}

function extractToolCalls(messages: Array<{ parts?: unknown[] }>): string[] {
  const calls: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (!isRecord(part) || part.type !== "tool") continue;
      const name = typeof part.tool === "string" ? part.tool : "unknown";
      const state = isRecord(part.state) ? part.state : {};
      const input = state.input === undefined ? "" : truncate(JSON.stringify(state.input), 160);
      calls.push(input ? `${name}(${input})` : name);
    }
  }
  return calls;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() || "Session memory";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
