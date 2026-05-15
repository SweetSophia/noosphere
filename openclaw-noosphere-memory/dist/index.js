import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createNoosphereAutoRecallHook } from "./auto-recall.js";
import { registerNoosphereCli } from "./cli.js";
import { createNoosphereCorpusSupplement } from "./corpus-supplement.js";
import { createNoosphereClientContextForAgent } from "./shared-init.js";
import { createNoosphereArticleCreateTool } from "./tools/article-create.js";
import { createNoosphereGetTool } from "./tools/get.js";
import { createNoosphereRecallTool } from "./tools/recall.js";
import { createNoosphereSaveTool } from "./tools/save.js";
import { createNoosphereStatusTool } from "./tools/status.js";
import { createNoosphereTopicsTool } from "./tools/topics.js";
export default definePluginEntry({
    id: "noosphere-memory",
    name: "Noosphere Memory Bridge",
    description: "Explicit OpenClaw tools and auto-recall prompt injection for Noosphere memory over HTTP.",
    register(api) {
        if (typeof api.registerCli === "function") {
            api.registerCli(({ program }) => registerNoosphereCli(program, api.pluginConfig, api.config), {
                descriptors: [
                    {
                        name: "noosphere",
                        description: "Inspect and operate the Noosphere memory integration",
                        hasSubcommands: true,
                    },
                ],
            });
        }
        if (api.registrationMode === "cli-metadata")
            return;
        // Pre-create the default context for CLI hooks (no agent context needed)
        const defaultContext = createNoosphereClientContextForAgent(api.pluginConfig, "unknown", api.config);
        // Register all tools as FACTORIES so they get agentId at execution time.
        // Each time a tool is invoked, the factory is called with the current
        // tool context containing the agent's id, and we build a per-agent
        // client with the correct API key.
        api.registerTool((ctx) => {
            const agentId = ctx.agentId ?? "default";
            const clientContext = createNoosphereClientContextForAgent(api.pluginConfig, agentId, api.config);
            return createNoosphereRecallTool(api.pluginConfig, clientContext);
        });
        api.registerTool((ctx) => {
            const agentId = ctx.agentId ?? "default";
            const clientContext = createNoosphereClientContextForAgent(api.pluginConfig, agentId, api.config);
            return createNoosphereGetTool(api.pluginConfig, clientContext);
        });
        api.registerTool((ctx) => {
            const agentId = ctx.agentId ?? "default";
            const clientContext = createNoosphereClientContextForAgent(api.pluginConfig, agentId, api.config);
            return createNoosphereSaveTool(api.pluginConfig, clientContext);
        });
        api.registerTool((ctx) => {
            const agentId = ctx.agentId ?? "default";
            const clientContext = createNoosphereClientContextForAgent(api.pluginConfig, agentId, api.config);
            return createNoosphereTopicsTool(api.pluginConfig, clientContext);
        });
        api.registerTool((ctx) => {
            const agentId = ctx.agentId ?? "default";
            const clientContext = createNoosphereClientContextForAgent(api.pluginConfig, agentId, api.config);
            return createNoosphereArticleCreateTool(api.pluginConfig, clientContext);
        });
        // Status tool uses default context (no agent routing needed for health checks)
        api.registerTool(createNoosphereStatusTool(api.pluginConfig, defaultContext));
        if (typeof api.registerMemoryCorpusSupplement === "function") {
            api.registerMemoryCorpusSupplement(createNoosphereCorpusSupplement(defaultContext, api.logger));
        }
        const hook = createNoosphereAutoRecallHook(api.pluginConfig, defaultContext, api.logger);
        if (typeof api.on === "function") {
            api.on("before_prompt_build", hook);
        }
        else {
            hook.registrationWarning?.();
        }
    },
});
//# sourceMappingURL=index.js.map