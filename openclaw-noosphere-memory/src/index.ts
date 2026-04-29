import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createNoosphereRecallTool } from "./tools/recall.js";
import { createNoosphereStatusTool } from "./tools/status.js";

export default definePluginEntry({
  id: "noosphere-memory",
  name: "Noosphere Memory Bridge",
  description: "Explicit OpenClaw tools for Noosphere memory status and recall over HTTP.",
  register(api) {
    api.registerTool(createNoosphereStatusTool(api.pluginConfig));
    api.registerTool(createNoosphereRecallTool(api.pluginConfig));
  },
});
