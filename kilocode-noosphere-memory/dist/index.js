import { tool } from "@kilocode/plugin";
import { NoosphereClient, NoosphereClientError } from "./client.js";
import { resolveConfig, redactSecret } from "./config.js";
import { clearSessionPrompts, markPendingCapture, clearPendingCapture, performAutoCapture, savePrompt } from "./capture.js";
import { formatAutoRecall, formatRecallResults, jsonToolResult } from "./format.js";
export const NoosphereKiloPlugin = async (ctx, options) => {
    const config = resolveConfig(options);
    const client = new NoosphereClient(config);
    const idleTimeoutsBySession = new Map();
    await log(ctx, "info", "Noosphere Kilo Code plugin initialized", {
        baseUrl: config.baseUrl,
        apiKey: redactSecret(config.apiKey),
        autoRecall: config.autoRecall,
        autoSave: config.autoSave,
    });
    return {
        "chat.message": async (input, output) => {
            if (!config.apiKey)
                return;
            try {
                const userMessage = extractText(output.parts);
                if (!userMessage)
                    return;
                const messageId = output.message.id;
                // Track prompt for auto-save whenever that feature is enabled —
                // independent of whether auto-recall is enabled (fixes silent
                // failure when NOOSPHERE_AUTO_RECALL=false but AUTO_SAVE=true).
                if (config.autoSave) {
                    savePrompt(input.sessionID, messageId, userMessage);
                }
                // Only run recall injection when auto-recall is explicitly enabled.
                if (!config.autoRecall)
                    return;
                if (!(await shouldInjectRecall(ctx, input.sessionID, config.autoRecallInjectOn))) {
                    return;
                }
                const recall = await client.recall({
                    query: userMessage.slice(0, 1_000),
                    mode: "auto",
                    providers: ["noosphere"],
                    resultCap: config.autoRecallMax,
                    tokenBudget: config.autoRecallTokenBudget,
                });
                const memoryContext = formatAutoRecall(recall);
                if (!memoryContext)
                    return;
                output.parts.unshift({
                    id: `prt-noosphere-context-${Date.now()}`,
                    sessionID: input.sessionID,
                    messageID: messageId,
                    type: "text",
                    text: memoryContext,
                    synthetic: true,
                });
            }
            catch (error) {
                await log(ctx, "warn", "Noosphere auto-recall failed", formatError(error));
            }
        },
        event: async ({ event }) => {
            if (event.type === "session.compacted") {
                clearSessionPrompts(event.properties.sessionID);
                const idleTimeout = idleTimeoutsBySession.get(event.properties.sessionID);
                if (idleTimeout)
                    clearTimeout(idleTimeout);
                idleTimeoutsBySession.delete(event.properties.sessionID);
                clearPendingCapture(event.properties.sessionID);
                return;
            }
            if (event.type !== "session.idle" || !config.autoSave || !config.apiKey) {
                return;
            }
            const sessionId = event.properties.sessionID;
            // Skip scheduling a new timeout if a save is already in-flight for this
            // session (prevents duplicate saves when multiple idle events fire while
            // a prior save has not yet completed).
            if (!markPendingCapture(sessionId))
                return;
            const existingIdleTimeout = idleTimeoutsBySession.get(sessionId);
            if (existingIdleTimeout)
                clearTimeout(existingIdleTimeout);
            const idleTimeout = setTimeout(() => {
                idleTimeoutsBySession.delete(sessionId);
                performAutoCapture(ctx, client, config, sessionId)
                    .catch((error) => {
                    void log(ctx, "warn", "Noosphere auto-save failed", formatError(error));
                })
                    .finally(() => {
                    clearPendingCapture(sessionId);
                });
            }, config.autoSaveDebounceMs);
            idleTimeoutsBySession.set(sessionId, idleTimeout);
        },
        tool: {
            noosphere_status: tool({
                description: "Check Noosphere memory connectivity and plugin configuration.",
                args: {},
                async execute() {
                    try {
                        return jsonToolResult({
                            ok: true,
                            config: {
                                baseUrl: config.baseUrl,
                                apiKey: redactSecret(config.apiKey),
                                autoRecall: config.autoRecall,
                                autoSave: config.autoSave,
                                autoSaveTopicId: config.autoSaveTopicId,
                            },
                            status: await client.status(),
                        });
                    }
                    catch (error) {
                        // /api/memory/status requires ADMIN (exposes internal provider config).
                        // Fall back to /api/health if the key is non-ADMIN (READ/WRITE).
                        if (error instanceof NoosphereClientError &&
                            error.status === 403) {
                            try {
                                const health = await client.health();
                                return jsonToolResult({
                                    ok: true,
                                    config: {
                                        baseUrl: config.baseUrl,
                                        apiKey: redactSecret(config.apiKey),
                                        autoRecall: config.autoRecall,
                                        autoSave: config.autoSave,
                                        autoSaveTopicId: config.autoSaveTopicId,
                                    },
                                    status: health,
                                    note: "Full memory/status unavailable (ADMIN key required); /api/health returned below.",
                                });
                            }
                            catch {
                                // Fall through to the error response.
                            }
                        }
                        return jsonToolResult({ ok: false, ...formatError(error) });
                    }
                },
            }),
            noosphere_recall: tool({
                description: "Search Noosphere durable memory for project history, prior decisions, runbooks, and technical context.",
                args: {
                    query: tool.schema.string().describe("Natural-language memory search query."),
                    resultCap: tool.schema.number().min(1).max(10).optional().describe("Maximum results to return."),
                    tokenBudget: tool.schema.number().min(100).max(2000).optional().describe("Prompt text token budget."),
                    scope: tool.schema.string().optional().describe("Optional Noosphere scope hint."),
                },
                async execute(args) {
                    try {
                        const response = await client.recall({
                            query: args.query,
                            mode: "inspection",
                            resultCap: args.resultCap,
                            tokenBudget: args.tokenBudget,
                            scope: args.scope,
                        });
                        return jsonToolResult({
                            ok: true,
                            formatted: formatRecallResults(response.results ?? []),
                            response,
                        });
                    }
                    catch (error) {
                        return jsonToolResult({ ok: false, ...formatError(error) });
                    }
                },
            }),
            noosphere_topics: tool({
                description: "List Noosphere topics so durable memories can be saved under the correct topic ID.",
                args: {},
                async execute() {
                    try {
                        return jsonToolResult({ ok: true, response: await client.topics() });
                    }
                    catch (error) {
                        return jsonToolResult({ ok: false, ...formatError(error) });
                    }
                },
            }),
            noosphere_save: tool({
                description: "Save durable, reusable knowledge to Noosphere as a draft memory candidate. Use only for stable decisions, runbooks, fixes, and project facts.",
                args: {
                    title: tool.schema.string().max(160).describe("Short title for the draft memory candidate."),
                    content: tool.schema.string().max(50000).describe("Durable memory content to save."),
                    topicId: tool.schema.string().max(128).describe("Noosphere topic ID/UUID. Use noosphere_topics if unknown."),
                    excerpt: tool.schema.string().max(500).optional().describe("Optional short summary."),
                    tags: tool.schema.array(tool.schema.string().max(64)).max(12).optional().describe("Optional tags."),
                    restrictedTags: tool.schema.array(tool.schema.string().max(64)).max(16).optional().describe("Optional restricted scope tags. Scoped API keys may only use their allowed scopes."),
                    source: tool.schema.string().max(500).optional().describe("Optional source pointer."),
                    confidence: tool.schema.enum(["low", "medium", "high"]).optional().describe("Initial confidence."),
                },
                async execute(args) {
                    try {
                        return jsonToolResult({
                            ok: true,
                            response: await client.save({
                                ...args,
                                authorName: config.authorName,
                            }),
                        });
                    }
                    catch (error) {
                        return jsonToolResult({ ok: false, ...formatError(error) });
                    }
                },
            }),
        },
    };
};
export const server = NoosphereKiloPlugin;
const NoosphereKiloPluginDescriptor = createNoosphereKiloPluginDescriptor();
export default NoosphereKiloPluginDescriptor;
function createNoosphereKiloPluginDescriptor() {
    return {
        id: "noosphere-memory",
        server: NoosphereKiloPlugin,
    };
}
async function shouldInjectRecall(ctx, sessionId, injectOn) {
    if (injectOn === "always")
        return true;
    try {
        const response = await ctx.client.session.messages({ path: { id: sessionId } });
        const messages = response.data ?? [];
        const nonSyntheticUserMessages = messages.filter((message) => message.info?.role === "user" &&
            Array.isArray(message.parts) &&
            !message.parts.every((part) => part.type !== "text" || part.synthetic === true));
        const lastMessage = messages[messages.length - 1];
        return nonSyntheticUserMessages.length === 0 || lastMessage?.info?.summary === true;
    }
    catch {
        return true;
    }
}
function extractText(parts) {
    return parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
}
async function log(ctx, level, message, extra) {
    try {
        await ctx.client.app.log({
            body: {
                service: "noosphere-kilocode-memory",
                level,
                message,
                extra: isRecord(extra) ? extra : { value: extra },
            },
        });
    }
    catch {
        // Logging must not block plugin startup or hooks.
    }
}
function formatError(error) {
    if (error instanceof Error) {
        const status = "status" in error ? error.status : undefined;
        return { error: error.message, status };
    }
    return { error: String(error) };
}
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=index.js.map