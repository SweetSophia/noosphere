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
import { isRecord, readBoolean } from "./config.js";

// Minimal type for the agent context we need from the OpenClaw plugin SDK.
// Full type is OpenClawPluginToolContext from openclaw/plugin-sdk/core.
interface ToolContext {
  agentId?: string;
}

export default definePluginEntry({
  id: "noosphere-memory",
  name: "Noosphere Memory Bridge",
  description:
    "Explicit OpenClaw tools and auto-recall prompt injection for Noosphere memory over HTTP.",
  register(api) {
    if (typeof api.registerCli === "function") {
      api.registerCli(
        ({ program }: { program: unknown }) =>
          registerNoosphereCli(
            program as Parameters<typeof registerNoosphereCli>[0],
            api.pluginConfig,
            api.config,
          ),
        {
          descriptors: [
            {
              name: "noosphere",
              description:
                "Inspect and operate the Noosphere memory integration",
              hasSubcommands: true,
            },
          ],
        },
      );
    }
    if (api.registrationMode === "cli-metadata") return;

    // Pre-create the default context for CLI hooks (no agent context needed)
    const defaultContext = createNoosphereClientContextForAgent(
      api.pluginConfig,
      "unknown",
      api.config,
    );

    // Register all tools as FACTORIES so they get agentId at execution time.
    // Each time a tool is invoked, the factory is called with the current
    // tool context containing the agent's id, and we build a per-agent
    // client with the correct API key.
    api.registerTool((ctx: ToolContext) => {
      const agentId = ctx.agentId ?? "default";
      const clientContext = createNoosphereClientContextForAgent(
        api.pluginConfig,
        agentId,
        api.config,
      );
      return createNoosphereRecallTool(api.pluginConfig, clientContext);
    });

    api.registerTool((ctx: ToolContext) => {
      const agentId = ctx.agentId ?? "default";
      const clientContext = createNoosphereClientContextForAgent(
        api.pluginConfig,
        agentId,
        api.config,
      );
      return createNoosphereGetTool(api.pluginConfig, clientContext);
    });

    api.registerTool((ctx: ToolContext) => {
      const agentId = ctx.agentId ?? "default";
      const clientContext = createNoosphereClientContextForAgent(
        api.pluginConfig,
        agentId,
        api.config,
      );
      return createNoosphereSaveTool(api.pluginConfig, clientContext);
    });

    api.registerTool((ctx: ToolContext) => {
      const agentId = ctx.agentId ?? "default";
      const clientContext = createNoosphereClientContextForAgent(
        api.pluginConfig,
        agentId,
        api.config,
      );
      return createNoosphereTopicsTool(api.pluginConfig, clientContext);
    });

    api.registerTool((ctx: ToolContext) => {
      const agentId = ctx.agentId ?? "default";
      const clientContext = createNoosphereClientContextForAgent(
        api.pluginConfig,
        agentId,
        api.config,
      );
      return createNoosphereArticleCreateTool(api.pluginConfig, clientContext);
    });

    // Status tool uses default context (no agent routing needed for health checks)
    api.registerTool(createNoosphereStatusTool(api.pluginConfig, defaultContext));

    if (
      typeof api.registerMemoryCorpusSupplement === "function" &&
      shouldRegisterDefaultCorpusSupplement(api.pluginConfig) &&
      defaultContext.config.apiKey
    ) {
      api.registerMemoryCorpusSupplement(
        createNoosphereCorpusSupplement(defaultContext, api.logger),
      );
    } else if (typeof api.registerMemoryCorpusSupplement === "function") {
      api.logger?.warn?.(
        "noosphere-memory: corpus supplement not registered; set allowDefaultCorpusSupplement=true to use the default API key for shared corpus access",
      );
    }

    const hook = createNoosphereAutoRecallHook(
      api.pluginConfig,
      (ctx) =>
        createNoosphereClientContextForAgent(
          api.pluginConfig,
          ctx.agentId ?? "default",
          api.config,
        ),
      api.logger,
    );
    if (typeof api.on === "function") {
      api.on("before_prompt_build", hook);
    } else {
      hook.registrationWarning?.();
    }
  },
});

function shouldRegisterDefaultCorpusSupplement(rawConfig: unknown): boolean {
  if (!isRecord(rawConfig)) return false;
  return readBoolean(rawConfig.allowDefaultCorpusSupplement) ?? false;
}
