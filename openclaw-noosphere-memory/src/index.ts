import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createNoosphereAutoRecallHook } from "./auto-recall.js";
import { createNoosphereClientContext } from "./shared-init.js";
import { createNoosphereRecallTool } from "./tools/recall.js";
import { createNoosphereStatusTool } from "./tools/status.js";

export default definePluginEntry({
  id: "noosphere-memory",
  name: "Noosphere Memory Bridge",
  description: "Explicit OpenClaw tools and optional auto-recall prompt injection for Noosphere memory over HTTP.",
  register(api) {
    const clientContext = createNoosphereClientContext(api.pluginConfig);
    api.registerTool(createNoosphereStatusTool(api.pluginConfig, clientContext));
    api.registerTool(createNoosphereRecallTool(api.pluginConfig, clientContext));
    api.on?.("before_prompt_build", createNoosphereAutoRecallHook(api.pluginConfig, clientContext, api.logger));
  },
});
