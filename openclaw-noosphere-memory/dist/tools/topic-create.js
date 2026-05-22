import { errorResult, jsonResult } from "../format.js";
import { createNoosphereClientContext, } from "../shared-init.js";
const TOPIC_NAME_MAX_LENGTH = 120;
const TOPIC_SLUG_MAX_LENGTH = 80;
const TOPIC_DESCRIPTION_MAX_LENGTH = 500;
const TOPIC_PARENT_ID_MAX_LENGTH = 128;
const TopicCreateToolParameters = {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
        name: {
            type: "string",
            description: "Topic display name.",
            maxLength: TOPIC_NAME_MAX_LENGTH,
        },
        slug: {
            type: "string",
            description: "Optional URL-safe slug. Noosphere derives one from name if omitted.",
            maxLength: TOPIC_SLUG_MAX_LENGTH,
            pattern: "^[a-z0-9-]+$",
        },
        parentId: {
            type: "string",
            description: "Optional parent topic ID/UUID. Use noosphere_topics first to find an existing parent.",
            maxLength: TOPIC_PARENT_ID_MAX_LENGTH,
        },
        description: {
            type: "string",
            description: "Optional topic description.",
            maxLength: TOPIC_DESCRIPTION_MAX_LENGTH,
        },
    },
};
export function createNoosphereTopicCreateTool(rawConfig, context) {
    const { config, client } = context ?? createNoosphereClientContext(rawConfig);
    return {
        name: "noosphere_topic_create",
        label: "Noosphere Topic Create",
        description: "Create a Noosphere topic or subtopic. Requires an ADMIN-scoped Noosphere API key. Use this when noosphere_article_create needs a topicId and the appropriate topic does not exist yet.",
        parameters: TopicCreateToolParameters,
        async execute(_toolCallId, rawParams) {
            try {
                const topic = await client.topicCreate(normalizeTopicCreateParams(rawParams));
                return jsonResult({ success: true, topic });
            }
            catch (error) {
                return errorResult(error, config);
            }
        },
    };
}
function normalizeTopicCreateParams(rawParams) {
    const params = isRecord(rawParams) ? rawParams : {};
    const name = readRequiredString(params.name, "name", TOPIC_NAME_MAX_LENGTH);
    const slug = readOptionalString(params.slug, "slug", TOPIC_SLUG_MAX_LENGTH);
    const parentId = readOptionalString(params.parentId, "parentId", TOPIC_PARENT_ID_MAX_LENGTH);
    const description = readOptionalString(params.description, "description", TOPIC_DESCRIPTION_MAX_LENGTH);
    if (slug && !/^[a-z0-9-]+$/.test(slug)) {
        throw new Error("slug must contain only lowercase ASCII letters, digits, and hyphens");
    }
    return {
        name,
        ...(slug ? { slug } : {}),
        ...(parentId ? { parentId } : {}),
        ...(description ? { description } : {}),
    };
}
function readRequiredString(value, field, maxLength) {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${field} is required`);
    }
    const trimmed = value.trim();
    if (trimmed.length > maxLength)
        throw new Error(`${field} is too long`);
    return trimmed;
}
function readOptionalString(value, field, maxLength) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== "string")
        throw new Error(`${field} must be a string`);
    const trimmed = value.trim();
    if (!trimmed)
        return undefined;
    if (trimmed.length > maxLength)
        throw new Error(`${field} is too long`);
    return trimmed;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=topic-create.js.map