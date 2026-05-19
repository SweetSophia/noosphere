import { truncate } from "./format.js";
const promptsBySession = new Map();
const capturedMessageIdsBySession = new Map();
const MAX_PROMPTS_PER_SESSION = 100;
const MIN_CAPTURE_LENGTH = 80;
const TRIVIAL_PROMPT_RE = /^(ok|okay|thanks?|thank you|done|yes|no|sure|nice|cool|great|got it)[.!?\s]*$/i;
export function savePrompt(sessionId, messageId, content) {
    const prompts = promptsBySession.get(sessionId) ?? [];
    prompts.push({ messageId, content, timestamp: Date.now() });
    if (prompts.length > MAX_PROMPTS_PER_SESSION)
        prompts.shift();
    promptsBySession.set(sessionId, prompts);
    pruneCapturedMessageIds(sessionId, prompts);
}
export function clearSessionPrompts(sessionId) {
    promptsBySession.delete(sessionId);
    capturedMessageIdsBySession.delete(sessionId);
}
export async function performAutoCapture(ctx, client, config, sessionId) {
    if (!config.autoSaveTopicId)
        return;
    const prompt = getLastUncapturedPrompt(sessionId);
    if (!prompt || shouldSkipPrompt(prompt.content))
        return;
    const messagesResponse = await ctx.client.session.messages({
        path: { id: sessionId },
    });
    const messages = messagesResponse.data ?? [];
    const promptIndex = messages.findIndex((message) => message.info?.id === prompt.messageId);
    if (promptIndex === -1)
        return;
    const aiMessages = messages.slice(promptIndex + 1).filter((message) => message.info?.role === "assistant");
    const textResponses = extractAssistantText(aiMessages);
    const toolCalls = extractToolCalls(aiMessages);
    if (textResponses.length === 0 && toolCalls.length === 0)
        return;
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
    if (content.length < MIN_CAPTURE_LENGTH)
        return;
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
function getLastUncapturedPrompt(sessionId) {
    const prompts = promptsBySession.get(sessionId) ?? [];
    for (let index = prompts.length - 1; index >= 0; index -= 1) {
        const prompt = prompts[index];
        if (prompt && !isPromptCaptured(sessionId, prompt.messageId))
            return prompt;
    }
    return undefined;
}
function isPromptCaptured(sessionId, messageId) {
    return capturedMessageIdsBySession.get(sessionId)?.has(messageId) ?? false;
}
function markPromptCaptured(sessionId, messageId) {
    const capturedMessageIds = capturedMessageIdsBySession.get(sessionId) ?? new Set();
    capturedMessageIds.add(messageId);
    capturedMessageIdsBySession.set(sessionId, capturedMessageIds);
}
function pruneCapturedMessageIds(sessionId, prompts) {
    const capturedMessageIds = capturedMessageIdsBySession.get(sessionId);
    if (!capturedMessageIds)
        return;
    const retainedMessageIds = new Set(prompts.map((prompt) => prompt.messageId));
    for (const messageId of capturedMessageIds) {
        if (!retainedMessageIds.has(messageId))
            capturedMessageIds.delete(messageId);
    }
    if (capturedMessageIds.size === 0)
        capturedMessageIdsBySession.delete(sessionId);
}
function shouldSkipPrompt(prompt) {
    const trimmed = prompt.trim();
    return trimmed.length < MIN_CAPTURE_LENGTH || TRIVIAL_PROMPT_RE.test(trimmed);
}
function extractAssistantText(messages) {
    const text = [];
    for (const message of messages) {
        if (!Array.isArray(message.parts))
            continue;
        for (const part of message.parts) {
            if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
                const value = part.text.trim();
                if (value)
                    text.push(value);
            }
        }
    }
    return text;
}
function extractToolCalls(messages) {
    const calls = [];
    for (const message of messages) {
        if (!Array.isArray(message.parts))
            continue;
        for (const part of message.parts) {
            if (!isRecord(part) || part.type !== "tool")
                continue;
            const name = typeof part.tool === "string" ? part.tool : "unknown";
            const state = isRecord(part.state) ? part.state : {};
            const input = state.input === undefined ? "" : truncate(JSON.stringify(state.input), 160);
            calls.push(input ? `${name}(${input})` : name);
        }
    }
    return calls;
}
function firstLine(value) {
    return value.split(/\r?\n/, 1)[0]?.trim() || "Session memory";
}
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=capture.js.map