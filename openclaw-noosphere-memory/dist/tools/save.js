import { errorResult, jsonResult } from "../format.js";
import { createNoosphereClientContext, } from "../shared-init.js";
const SAVE_TITLE_MAX_LENGTH = 160;
const SAVE_CONTENT_MAX_LENGTH = 50_000;
const SAVE_TOPIC_ID_MAX_LENGTH = 128;
const SAVE_TAG_MAX_COUNT = 12;
const SAVE_TAG_MAX_LENGTH = 64;
const SAVE_RESTRICTED_TAG_MAX_COUNT = 16;
const SAVE_RESTRICTED_TAG_MAX_LENGTH = 64;
const SaveToolParameters = {
    type: "object",
    additionalProperties: false,
    required: ["title", "content", "topicId"],
    properties: {
        title: {
            type: "string",
            description: "Short title for the draft memory candidate.",
            maxLength: SAVE_TITLE_MAX_LENGTH,
        },
        content: {
            type: "string",
            description: "Durable memory content to save as a draft candidate. Injected recall blocks are stripped server-side.",
            maxLength: SAVE_CONTENT_MAX_LENGTH,
        },
        topicId: {
            type: "string",
            description: 'Actual Noosphere topic ID/UUID where the draft candidate should be filed, e.g. "550e8400-e29b-41d4-a716-446655440000". Do not pass guessed slugs unless slug aliases are explicitly supported.',
            maxLength: SAVE_TOPIC_ID_MAX_LENGTH,
        },
        excerpt: {
            type: "string",
            maxLength: 500,
            description: "Optional short summary/excerpt.",
        },
        tags: {
            type: "array",
            maxItems: SAVE_TAG_MAX_COUNT,
            items: { type: "string", maxLength: SAVE_TAG_MAX_LENGTH },
            description: "Optional tags. Duplicates are normalized by slug server-side while preserving first-seen display casing.",
        },
        restrictedTags: {
            type: "array",
            maxItems: SAVE_RESTRICTED_TAG_MAX_COUNT,
            items: { type: "string", maxLength: SAVE_RESTRICTED_TAG_MAX_LENGTH },
            description: "Optional access scopes. Scoped API keys can only assign their own scopes; if omitted, Noosphere defaults scoped keys to their allowed scopes.",
        },
        source: {
            type: "string",
            maxLength: 500,
            description: "Optional source pointer, e.g. session key, URL, or canonical ref.",
        },
        authorName: {
            type: "string",
            maxLength: 100,
            description: "Optional display author name.",
        },
        confidence: {
            type: "string",
            enum: ["low", "medium", "high"],
            description: "Initial confidence for the draft candidate.",
        },
    },
};
export function createNoosphereSaveTool(rawConfig, context) {
    const { config, client } = context ?? createNoosphereClientContext(rawConfig);
    return {
        name: "noosphere_save",
        label: "Noosphere Save Candidate",
        description: "Save durable content to Noosphere as a draft memory candidate. This never publishes directly.",
        parameters: SaveToolParameters,
        async execute(_toolCallId, rawParams) {
            try {
                const params = normalizeSaveParams(rawParams);
                return jsonResult(await client.save(params));
            }
            catch (error) {
                return errorResult(error, config);
            }
        },
    };
}
function normalizeSaveParams(rawParams) {
    const params = isRecord(rawParams) ? rawParams : {};
    const restrictedTags = readOptionalStringArray(params.restrictedTags, "restrictedTags", SAVE_RESTRICTED_TAG_MAX_COUNT, SAVE_RESTRICTED_TAG_MAX_LENGTH);
    return {
        title: readRequiredString(params.title, "title", SAVE_TITLE_MAX_LENGTH),
        content: readRequiredString(params.content, "content", SAVE_CONTENT_MAX_LENGTH),
        topicId: readRequiredString(params.topicId, "topicId", SAVE_TOPIC_ID_MAX_LENGTH),
        excerpt: readOptionalString(params.excerpt, "excerpt", 500),
        tags: readOptionalTags(params.tags),
        ...(restrictedTags ? { restrictedTags } : {}),
        source: readOptionalString(params.source, "source", 500),
        authorName: readOptionalString(params.authorName, "authorName", 100),
        confidence: readOptionalConfidence(params.confidence),
    };
}
function readOptionalStringArray(value, field, maxItems, maxLength) {
    if (value === undefined || value === null)
        return undefined;
    if (!Array.isArray(value))
        throw new Error(`${field} must be an array of strings`);
    if (value.length > maxItems)
        throw new Error(`too many ${field}`);
    const seen = new Set();
    const values = [];
    for (const item of value) {
        if (typeof item !== "string") {
            throw new Error(`${field} must be an array of strings`);
        }
        const normalized = item.trim();
        if (!normalized)
            continue;
        if (normalized.length > maxLength) {
            throw new Error(`${field} item is too long`);
        }
        if (!seen.has(normalized)) {
            seen.add(normalized);
            values.push(normalized);
        }
    }
    return values.length ? values : undefined;
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
function readOptionalTags(value) {
    if (value === undefined || value === null)
        return undefined;
    if (!Array.isArray(value))
        throw new Error("tags must be an array of strings");
    if (value.length > SAVE_TAG_MAX_COUNT)
        throw new Error("too many tags");
    const tags = [];
    for (const tag of value) {
        if (typeof tag !== "string")
            throw new Error("tags must be an array of strings");
        const normalized = tag.trim();
        if (!normalized)
            continue;
        if (normalized.length > SAVE_TAG_MAX_LENGTH)
            throw new Error("tag is too long");
        tags.push(normalized);
    }
    return tags.length ? tags : undefined;
}
function readOptionalConfidence(value) {
    if (value === undefined || value === null || value === "")
        return undefined;
    if (value === "low" || value === "medium" || value === "high")
        return value;
    throw new Error("confidence must be low, medium, or high");
}
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=save.js.map