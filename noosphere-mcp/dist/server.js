import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
const confidence = z.enum(["low", "medium", "high"]);
const status = z.enum(["draft", "reviewed", "published"]);
const nonEmpty = z.string().trim().min(1);
const canonicalArticleRef = nonEmpty
    .max(512)
    .regex(/^noosphere:article:[^:\s]+$/, "Use a canonical reference like noosphere:article:<id>.");
const saveTags = z.array(nonEmpty.max(64)).max(12).optional();
const articleTags = z.array(nonEmpty.max(100)).max(100).optional();
const restrictedTags = z.array(nonEmpty.max(64)).max(16).optional();
const articleContent = nonEmpty
    .max(1_048_576)
    .refine((value) => new TextEncoder().encode(value).byteLength <= 1_048_576, "Content must not exceed 1048576 UTF-8 bytes.");
const searchArticlesSchema = {
    query: nonEmpty.max(256).optional().describe("Full-text query. Omit to list recent accessible articles."),
    topic: nonEmpty.max(100).optional().describe("Topic slug filter."),
    tag: nonEmpty.max(100).optional().describe("Tag slug filter."),
    status: status.optional(),
    confidence: confidence.optional(),
    page: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
};
const getArticleSchema = z.object({
    articleId: nonEmpty.max(512).optional().describe("Noosphere article ID."),
    canonicalRef: canonicalArticleRef.optional().describe("Canonical reference such as noosphere:article:<id>."),
}).refine((value) => Number(Boolean(value.articleId)) + Number(Boolean(value.canonicalRef)) === 1, {
    message: "Provide exactly one of articleId or canonicalRef.",
});
const saveMemorySchema = {
    title: nonEmpty.max(160),
    content: nonEmpty.min(40).max(50_000),
    topicId: nonEmpty.max(128),
    excerpt: z.string().max(500).optional(),
    tags: saveTags,
    source: z.string().max(500).optional(),
    authorName: z.string().max(100).optional(),
    confidence: confidence.optional(),
    restrictedTags,
};
const recallMemorySchema = {
    query: nonEmpty.max(1_000),
    resultCap: z.number().int().min(1).max(10).optional(),
    tokenBudget: z.number().int().min(1).max(2_000).optional(),
    scope: z.string().trim().max(500).optional(),
    providers: z.array(nonEmpty.max(100)).min(1).max(20).optional(),
};
const createArticleSchema = {
    title: nonEmpty.max(200),
    slug: nonEmpty.max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use a lowercase hyphenated slug."),
    content: articleContent,
    topicId: nonEmpty.max(500),
    excerpt: z.string().max(500).optional(),
    tags: articleTags,
    authorName: z.string().max(100).optional(),
    confidence: confidence.optional(),
    status: status.optional(),
    relatedArticleIds: z.array(nonEmpty.max(500)).max(100).optional(),
    restrictedTags,
};
const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
};
const additiveWriteAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
};
export function createNoosphereMcpServer(api, version) {
    const server = new McpServer({ name: "noosphere", version }, {
        instructions: "Use search_articles or recall_memory before creating duplicate knowledge. save_memory always creates a draft candidate; create_article is an explicit curated write.",
    });
    server.registerTool("search_articles", {
        title: "Search Noosphere articles",
        description: "Search or list accessible Noosphere wiki articles. Omit query to list recent articles and discover topic IDs.",
        inputSchema: searchArticlesSchema,
        annotations: { title: "Search Noosphere articles", ...readOnlyAnnotations },
    }, async (input) => execute(() => api.searchArticles(input)));
    server.registerTool("get_article", {
        title: "Get a Noosphere article",
        description: "Fetch one normalized Noosphere article by article ID or canonical reference.",
        inputSchema: getArticleSchema,
        annotations: { title: "Get a Noosphere article", ...readOnlyAnnotations },
    }, async (input) => execute(() => api.getArticle(input)));
    server.registerTool("save_memory", {
        title: "Save a Noosphere memory draft",
        description: "Save durable reusable knowledge as a draft memory candidate for later review.",
        inputSchema: saveMemorySchema,
        annotations: { title: "Save a Noosphere memory draft", ...additiveWriteAnnotations },
    }, async (input) => execute(() => api.saveMemory(input)));
    server.registerTool("recall_memory", {
        title: "Recall Noosphere memory",
        description: "Run provider-aware Noosphere recall in bounded automatic mode with optional result and token budgets.",
        inputSchema: recallMemorySchema,
        annotations: { title: "Recall Noosphere memory", ...readOnlyAnnotations },
    }, async (input) => execute(() => api.recallMemory(input)));
    server.registerTool("create_article", {
        title: "Create a Noosphere article",
        description: "Create a curated Noosphere wiki article. This is an additive write, not a draft memory save.",
        inputSchema: createArticleSchema,
        annotations: { title: "Create a Noosphere article", ...additiveWriteAnnotations },
    }, async (input) => execute(() => api.createArticle(input)));
    return server;
}
async function execute(operation) {
    try {
        const result = await operation();
        return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
        };
    }
    catch (error) {
        const message = boundedErrorMessage(error);
        return {
            content: [{ type: "text", text: message }],
            isError: true,
        };
    }
}
function boundedErrorMessage(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.length <= 2_000 ? message : `${message.slice(0, 2_000)}…`;
}
//# sourceMappingURL=server.js.map