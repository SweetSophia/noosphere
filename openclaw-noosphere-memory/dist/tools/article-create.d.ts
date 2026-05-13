import { NoosphereClientContext } from "../shared-init.js";
export declare function createNoosphereArticleCreateTool(rawConfig: unknown, context?: NoosphereClientContext): {
    name: string;
    label: string;
    description: string;
    parameters: {
        readonly type: "object";
        readonly additionalProperties: false;
        readonly required: readonly ["topicId", "title", "content"];
        readonly properties: {
            readonly topicId: {
                readonly type: "string";
                readonly description: "The Noosphere topic ID/UUID. Use noosphere_topics first to find the correct ID.";
            };
            readonly title: {
                readonly type: "string";
                readonly description: "Article title (max 160 chars).";
                readonly maxLength: 160;
            };
            readonly content: {
                readonly type: "string";
                readonly description: "Article Markdown content.";
                readonly minLength: 40;
            };
            readonly slug: {
                readonly type: "string";
                readonly description: "URL-safe slug (auto-generated from title if omitted).";
            };
            readonly excerpt: {
                readonly type: "string";
                readonly description: "Short summary (auto-derived from content if omitted).";
                readonly maxLength: 500;
            };
            readonly tags: {
                readonly type: "array";
                readonly maxItems: 12;
                readonly items: {
                    readonly type: "string";
                    readonly maxLength: 64;
                };
                readonly description: "Tags for categorization.";
            };
            readonly authorName: {
                readonly type: "string";
                readonly description: "Display author name (defaults to 'OpenClaw Agent').";
                readonly maxLength: 100;
            };
            readonly confidence: {
                readonly type: "string";
                readonly enum: readonly ["low", "medium", "high"];
            };
            readonly status: {
                readonly type: "string";
                readonly enum: readonly ["draft", "reviewed", "published"];
                readonly description: "Article lifecycle status. Defaults to 'reviewed'.";
            };
        };
    };
    execute(_toolCallId: string, rawParams: unknown): Promise<import("../format.js").ToolTextResult>;
};
//# sourceMappingURL=article-create.d.ts.map