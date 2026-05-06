import { NoosphereClientContext } from "../shared-init.js";
export declare function createNoosphereSaveTool(rawConfig: unknown, context?: NoosphereClientContext): {
    name: string;
    label: string;
    description: string;
    parameters: {
        readonly type: "object";
        readonly additionalProperties: false;
        readonly required: readonly ["title", "content", "topicId"];
        readonly properties: {
            readonly title: {
                readonly type: "string";
                readonly description: "Short title for the draft memory candidate.";
                readonly maxLength: 160;
            };
            readonly content: {
                readonly type: "string";
                readonly description: "Durable memory content to save as a draft candidate. Injected recall blocks are stripped server-side.";
                readonly maxLength: 50000;
            };
            readonly topicId: {
                readonly type: "string";
                readonly description: "Noosphere topic ID where the draft candidate should be filed.";
                readonly maxLength: 128;
            };
            readonly excerpt: {
                readonly type: "string";
                readonly maxLength: 500;
                readonly description: "Optional short summary/excerpt.";
            };
            readonly tags: {
                readonly type: "array";
                readonly maxItems: 12;
                readonly items: {
                    readonly type: "string";
                    readonly maxLength: 64;
                };
                readonly description: "Optional tags. Duplicates are normalized by slug server-side while preserving first-seen display casing.";
            };
            readonly source: {
                readonly type: "string";
                readonly maxLength: 500;
                readonly description: "Optional source pointer, e.g. session key, URL, or canonical ref.";
            };
            readonly authorName: {
                readonly type: "string";
                readonly maxLength: 100;
                readonly description: "Optional display author name.";
            };
            readonly confidence: {
                readonly type: "string";
                readonly enum: readonly ["low", "medium", "high"];
                readonly description: "Initial confidence for the draft candidate.";
            };
        };
    };
    execute(_toolCallId: string, rawParams: unknown): Promise<import("../format.js").ToolTextResult>;
};
//# sourceMappingURL=save.d.ts.map