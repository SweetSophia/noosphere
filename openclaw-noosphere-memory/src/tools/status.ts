import { NoosphereMemoryClient } from "../client.js";
import { resolveNoosphereMemoryConfig } from "../config.js";
import { errorResult, jsonResult } from "../format.js";

export function createNoosphereStatusTool(rawConfig: unknown) {
  return {
    name: "noosphere_status",
    label: "Noosphere Status",
    description: "Check Noosphere memory API health, provider metadata, and public recall settings.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    async execute() {
      const config = resolveNoosphereMemoryConfig(rawConfig);
      const client = new NoosphereMemoryClient(config);
      try {
        return jsonResult(await client.status());
      } catch (error) {
        return errorResult(error, config);
      }
    },
  };
}
