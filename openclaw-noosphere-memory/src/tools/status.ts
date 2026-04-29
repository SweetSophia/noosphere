import { errorResult, jsonResult } from "../format.js";
import { createNoosphereClientContext, NoosphereClientContext } from "../shared-init.js";

export function createNoosphereStatusTool(rawConfig: unknown, context?: NoosphereClientContext) {
  const { config, client } = context ?? createNoosphereClientContext(rawConfig);

  return {
    name: "noosphere_status",
    label: "Noosphere Status",
    description: "Check Noosphere memory API health, provider metadata, and public recall settings. Requires an ADMIN-scoped Noosphere API key.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    async execute() {
      try {
        return jsonResult(await client.status());
      } catch (error) {
        return errorResult(error, config);
      }
    },
  };
}
