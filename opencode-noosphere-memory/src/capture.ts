import type { PluginInput } from "@opencode-ai/plugin";
import type { NoosphereClient } from "./client.js";
import type { NoospherePluginConfig, SessionPrompt } from "./types.js";
import { truncate } from "./format.js";

const promptsBySession = new Map<string, SessionPrompt[]>();
const capturedMessageIds = new Set<string>();
const MAX_PROMPTS_PER_SESSION = 100;
const MIN_CAPTURE_LENGTH = 80;
const TRIVIAL_PROMPT_RE =
  /^(ok|okay|thanks?|thank you|done|yes|no|sure|nice|cool|great|got it)[.!?\s]*$/i;

export function savePrompt(sessionId: string, messageId: string, content: string): void {
  const prompts = promptsBySession.get(sessionId) ?? [];
  prompts.push({ messageId, content, timestamp: Date.now() });
  if (prompts.length > MAX_PROMPTS_PER_SESSION) prompts.shift();
  promptsBySession.set(sessionId, prompts);
}

export function clearSessionPrompts(sessionId: string): void {
  promptsBySession.delete(sessionId);
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

  capturedMessageIds.add(prompt.messageId);

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
}

function getLastUncapturedPrompt(sessionId: string): SessionPrompt | undefined {
  const prompts = promptsBySession.get(sessionId) ?? [];
  for (let index = prompts.length - 1; index >= 0; index -= 1) {
    const prompt = prompts[index];
    if (prompt && !capturedMessageIds.has(prompt.messageId)) return prompt;
  }
  return undefined;
}

function shouldSkipPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  return trimmed.length < MIN_CAPTURE_LENGTH || TRIVIAL_PROMPT_RE.test(trimmed);
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
