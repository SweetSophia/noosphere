import { errorResult, jsonResult } from "../format.js";
import {
  createNoosphereClientContext,
  NoosphereClientContext,
} from "../shared-init.js";

const TopicsToolParameters = {
  type: "object",
  additionalProperties: false,
  properties: {},
  required: [],
} as const;

export function createNoosphereTopicsTool(
  rawConfig: unknown,
  context?: NoosphereClientContext,
) {
  const { config, client } = context ?? createNoosphereClientContext(rawConfig);

  return {
    name: "noosphere_topics",
    label: "Noosphere Topics",
    description:
      "List all Noosphere topics in hierarchical tree form. Returns id, name, slug, description, articleCount, and nested children for each topic. Use this to find the correct topicId before creating a memory candidate with noosphere_save.",
    parameters: TopicsToolParameters,
    async execute() {
      try {
        return jsonResult(await client.topics());
      } catch (error) {
        return errorResult(error, config);
      }
    },
  };
}
