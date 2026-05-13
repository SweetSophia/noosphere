import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createNoosphereAutoRecallHook } from "./auto-recall.js";
import { registerNoosphereCli } from "./cli.js";
import { createNoosphereCorpusSupplement } from "./corpus-supplement.js";
import { createNoosphereClientContext } from "./shared-init.js";
import { createNoosphereArticleCreateTool } from "./tools/article-create.js";
import { createNoosphereGetTool } from "./tools/get.js";
import { createNoosphereRecallTool } from "./tools/recall.js";
import { createNoosphereSaveTool } from "./tools/save.js";
import { createNoosphereStatusTool } from "./tools/status.js";
import { createNoosphereTopicsTool } from "./tools/topics.js";

export default definePluginEntry({
  id: "noosphere-memory",
  name: "Noosphere Memory Bridge",
  description:
    "Explicit OpenClaw tools and optional auto-recall prompt injection for Noosphere memory over HTTP.",
  register(api) {
    if (typeof api.registerCli === "function") {
      api.registerCli(
        ({ program }: { program: unknown }) => registerNoosphereCli(
          program as Parameters<typeof registerNoosphereCli>[0],
          api.pluginConfig,
          api.config,
        ),
        {
          descriptors: [{
            name: "noosphere",
            description: "Inspect and operate the Noosphere memory integration",
            hasSubcommands: true,
          }],
        },
      );
    }
    if (api.registrationMode === "cli-metadata") return;

    const clientContext = createNoosphereClientContext(api.pluginConfig, api.config);
    api.registerTool(
      createNoosphereStatusTool(api.pluginConfig, clientContext),
    );
    api.registerTool(
      createNoosphereRecallTool(api.pluginConfig, clientContext),
    );
    api.registerTool(createNoosphereGetTool(api.pluginConfig, clientContext));
    api.registerTool(createNoosphereSaveTool(api.pluginConfig, clientContext));
    api.registerTool(createNoosphereTopicsTool(api.pluginConfig, clientContext));
    api.registerTool(
      createNoosphereArticleCreateTool(api.pluginConfig, clientContext),
    );
    if (typeof api.registerMemoryCorpusSupplement === "function") {
      api.registerMemoryCorpusSupplement(
        createNoosphereCorpusSupplement(clientContext, api.logger),
      );
    }
    const hook = createNoosphereAutoRecallHook(
      api.pluginConfig,
      clientContext,
      api.logger,
    );
    if (typeof api.on === "function") {
      api.on("before_prompt_build", hook);
    } else {
      hook.registrationWarning?.();
    }
  },
});
