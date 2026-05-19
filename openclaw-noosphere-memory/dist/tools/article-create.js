import crypto from "node:crypto";
import { errorResult, jsonResult } from "../format.js";
import { createNoosphereClientContext, } from "../shared-init.js";
const ARTICLE_TITLE_MAX_LENGTH = 160;
const ARTICLE_CONTENT_MIN_LENGTH = 40;
const ARTICLE_CONTENT_MAX_BYTES = 1024 * 1024;
const ARTICLE_TOPIC_ID_MAX_LENGTH = 128;
const ARTICLE_SLUG_MAX_LENGTH = 80;
const ARTICLE_EXCERPT_MAX_LENGTH = 500;
const ARTICLE_TAG_MAX_COUNT = 12;
const ARTICLE_TAG_MAX_LENGTH = 64;
const ARTICLE_RESTRICTED_TAG_MAX_COUNT = 16;
const ARTICLE_RESTRICTED_TAG_MAX_LENGTH = 64;
const ARTICLE_AUTHOR_NAME_MAX_LENGTH = 100;
const INJECTED_MEMORY_BLOCKS = [
    "recall",
    "hindsight_memories",
    "noosphere_auto_recall",
];
const ArticleCreateToolParameters = {
    type: "object",
    additionalProperties: false,
    required: ["topicId", "title", "content"],
    properties: {
        topicId: {
            type: "string",
            description: "The Noosphere topic ID/UUID. Use noosphere_topics first to find the correct ID.",
        },
        title: {
            type: "string",
            description: "Article title (max 160 chars).",
            maxLength: ARTICLE_TITLE_MAX_LENGTH,
        },
        content: {
            type: "string",
            description: "Article Markdown content.",
            minLength: ARTICLE_CONTENT_MIN_LENGTH,
            maxLength: ARTICLE_CONTENT_MAX_BYTES,
        },
        slug: {
            type: "string",
            description: "URL-safe slug (auto-generated from title if omitted).",
            maxLength: ARTICLE_SLUG_MAX_LENGTH,
            pattern: "^[a-z0-9-]+$",
        },
        excerpt: {
            type: "string",
            description: "Short summary (auto-derived from content if omitted).",
            maxLength: ARTICLE_EXCERPT_MAX_LENGTH,
        },
        tags: {
            type: "array",
            maxItems: ARTICLE_TAG_MAX_COUNT,
            items: { type: "string", maxLength: ARTICLE_TAG_MAX_LENGTH },
            description: "Tags for categorization.",
        },
        restrictedTags: {
            type: "array",
            maxItems: ARTICLE_RESTRICTED_TAG_MAX_COUNT,
            items: { type: "string", maxLength: ARTICLE_RESTRICTED_TAG_MAX_LENGTH },
            description: "Optional access scopes. Scoped API keys can only assign their own scopes; if omitted, Noosphere defaults scoped keys to their allowed scopes.",
        },
        authorName: {
            type: "string",
            description: "Optional display author name. Omit to let Noosphere attribute the article from the authenticated context.",
            maxLength: ARTICLE_AUTHOR_NAME_MAX_LENGTH,
        },
        confidence: {
            type: "string",
            enum: ["low", "medium", "high"],
        },
        status: {
            type: "string",
            enum: ["draft", "reviewed", "published"],
            description: "Article lifecycle status. Defaults to 'published'.",
        },
    },
};
export function createNoosphereArticleCreateTool(rawConfig, context) {
    const { config, client } = context ?? createNoosphereClientContext(rawConfig);
    return {
        name: "noosphere_article_create",
        label: "Noosphere Article Create",
        description: "Create a curated Noosphere wiki article (not just a draft memory candidate). Use this for structured knowledge worth preserving as a proper wiki article. For simple memory candidates that need editorial review, use noosphere_save instead.",
        parameters: ArticleCreateToolParameters,
        async execute(_toolCallId, rawParams) {
            try {
                const params = normalizeArticleCreateParams(rawParams);
                const article = await client.articleCreate(params.request);
                return jsonResult({
                    success: true,
                    article,
                    strippedBlocks: params.strippedBlocks,
                });
            }
            catch (error) {
                return errorResult(error, config);
            }
        },
    };
}
function normalizeArticleCreateParams(rawParams) {
    const params = isRecord(rawParams) ? rawParams : {};
    const title = readRequiredString(params.title, "title", ARTICLE_TITLE_MAX_LENGTH);
    const topicId = readRequiredString(params.topicId, "topicId", ARTICLE_TOPIC_ID_MAX_LENGTH);
    const stripped = stripInjectedMemoryBlocks(readRequiredString(params.content, "content"));
    const content = normalizeContent(stripped.content);
    validateMeaningfulContent(content);
    validateContentByteLength(content);
    const slug = readOptionalString(params.slug, "slug", ARTICLE_SLUG_MAX_LENGTH)
        ?? deriveSlug(title);
    if (!slug)
        throw new Error("slug could not be generated from title");
    validateSlug(slug);
    const authorName = readOptionalString(params.authorName, "authorName", ARTICLE_AUTHOR_NAME_MAX_LENGTH);
    const restrictedTags = readOptionalStringArray(params.restrictedTags, "restrictedTags", ARTICLE_RESTRICTED_TAG_MAX_COUNT, ARTICLE_RESTRICTED_TAG_MAX_LENGTH);
    return {
        request: {
            topicId,
            title,
            content,
            slug,
            excerpt: readOptionalString(params.excerpt, "excerpt", ARTICLE_EXCERPT_MAX_LENGTH)
                ?? deriveExcerpt(content),
            tags: readOptionalTags(params.tags),
            ...(restrictedTags ? { restrictedTags } : {}),
            ...(authorName ? { authorName } : {}),
            confidence: readOptionalConfidence(params.confidence),
            status: readOptionalStatus(params.status) ?? "published",
        },
        strippedBlocks: stripped.strippedBlocks,
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
    if (maxLength !== undefined && trimmed.length > maxLength) {
        throw new Error(`${field} is too long`);
    }
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
    if (value.length > ARTICLE_TAG_MAX_COUNT)
        throw new Error("too many tags");
    const tags = [];
    for (const tag of value) {
        if (typeof tag !== "string") {
            throw new Error("tags must be an array of strings");
        }
        const normalized = tag.trim();
        if (!normalized)
            continue;
        if (normalized.length > ARTICLE_TAG_MAX_LENGTH) {
            throw new Error("tag is too long");
        }
        const normalizedSlug = slugify(normalized);
        if (!normalizedSlug) {
            throw new Error("tag must contain at least one ASCII letter or digit because Noosphere tag slugs are ASCII-only");
        }
        if (!tags.some((existing) => slugify(existing) === normalizedSlug)) {
            tags.push(normalized);
        }
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
function readOptionalStatus(value) {
    if (value === undefined || value === null || value === "")
        return undefined;
    if (value === "draft" || value === "reviewed" || value === "published") {
        return value;
    }
    throw new Error("status must be draft, reviewed, or published");
}
function normalizeContent(content) {
    return content
        .replace(/\r\n/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
function validateMeaningfulContent(content) {
    if (content.length < ARTICLE_CONTENT_MIN_LENGTH) {
        throw new Error("content is too short to create a curated article");
    }
    const letterCount = Array.from(content.matchAll(/\p{L}/gu)).length;
    if (letterCount < 12) {
        throw new Error("content must contain meaningful prose");
    }
}
function validateContentByteLength(content) {
    const byteLength = new TextEncoder().encode(content).byteLength;
    if (byteLength > ARTICLE_CONTENT_MAX_BYTES) {
        throw new Error("content exceeds the 1 MB article size limit");
    }
}
function stripInjectedMemoryBlocks(content) {
    let strippedContent = content;
    const strippedBlocks = [];
    for (const tag of INJECTED_MEMORY_BLOCKS) {
        let nextContent = stripOneInjectedTag(strippedContent, tag);
        while (nextContent.changed) {
            strippedBlocks.push(tag);
            strippedContent = nextContent.content;
            nextContent = stripOneInjectedTag(strippedContent, tag);
        }
    }
    return { content: strippedContent, strippedBlocks };
}
function stripOneInjectedTag(content, tag) {
    const openPattern = new RegExp(`<${tag}(?=[\\s>/])[^>]*>`, "i");
    const openMatch = openPattern.exec(content);
    if (!openMatch)
        return { content, changed: false };
    const closePattern = new RegExp(`</${tag}\\s*>`, "gi");
    const openSearchPattern = new RegExp(`<${tag}(?=[\\s>/])[^>]*>`, "gi");
    closePattern.lastIndex = openMatch.index + openMatch[0].length;
    openSearchPattern.lastIndex = openMatch.index + openMatch[0].length;
    let depth = 1;
    let cursor = openMatch.index + openMatch[0].length;
    while (true) {
        openSearchPattern.lastIndex = cursor;
        closePattern.lastIndex = cursor;
        const nestedOpen = openSearchPattern.exec(content);
        const closeMatch = closePattern.exec(content);
        if (!closeMatch) {
            throw new Error(`Unclosed memory block tag: <${tag}>`);
        }
        if (nestedOpen && nestedOpen.index < closeMatch.index) {
            depth += 1;
            cursor = nestedOpen.index + nestedOpen[0].length;
            continue;
        }
        depth -= 1;
        cursor = closeMatch.index + closeMatch[0].length;
        if (depth === 0) {
            return {
                content: `${content.slice(0, openMatch.index)}\n${content.slice(cursor)}`,
                changed: true,
            };
        }
    }
}
function deriveSlug(value) {
    const slug = slugify(value);
    if (slug)
        return slug;
    return `article-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
function slugify(value) {
    return value
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-")
        .slice(0, ARTICLE_SLUG_MAX_LENGTH)
        .replace(/-+$/g, "");
}
function validateSlug(slug) {
    if (!/^[a-z0-9-]+$/.test(slug)) {
        throw new Error("slug must be lowercase alphanumeric with hyphens only");
    }
}
function deriveExcerpt(content) {
    return content
        .replace(/[#*`_>\-\[\]]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
}
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=article-create.js.map