import { errorResult, jsonResult } from "../format.js";
import { createNoosphereClientContext, } from "../shared-init.js";
const TopicsToolParameters = {
    type: "object",
    additionalProperties: false,
    properties: {},
    required: [],
};
export function createNoosphereTopicsTool(rawConfig, context) {
    const { config, client } = context ?? createNoosphereClientContext(rawConfig);
    return {
        name: "noosphere_topics",
        label: "Noosphere Topics",
        description: "List all Noosphere topics in hierarchical tree form. Returns id, name, slug, description, articleCount, and nested children for each topic. Use this to find the correct topicId before creating a memory candidate with noosphere_save.",
        parameters: TopicsToolParameters,
        async execute() {
            try {
                return jsonResult(await client.topics());
            }
            catch (error) {
                return errorResult(error, config);
            }
        },
    };
}
//# sourceMappingURL=topics.js.map