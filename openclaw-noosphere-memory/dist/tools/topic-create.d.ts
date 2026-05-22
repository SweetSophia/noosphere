import { NoosphereClientContext } from "../shared-init.js";
export declare function createNoosphereTopicCreateTool(rawConfig: unknown, context?: NoosphereClientContext): {
    name: string;
    label: string;
    description: string;
    parameters: {
        readonly type: "object";
        readonly additionalProperties: false;
        readonly required: readonly ["name"];
        readonly properties: {
            readonly name: {
                readonly type: "string";
                readonly description: "Topic display name.";
                readonly maxLength: 120;
            };
            readonly slug: {
                readonly type: "string";
                readonly description: "Optional URL-safe slug. Noosphere derives one from name if omitted.";
                readonly maxLength: 80;
                readonly pattern: "^[a-z0-9-]+$";
            };
            readonly parentId: {
                readonly type: "string";
                readonly description: "Optional parent topic ID/UUID. Use noosphere_topics first to find an existing parent.";
                readonly maxLength: 128;
            };
            readonly description: {
                readonly type: "string";
                readonly description: "Optional topic description.";
                readonly maxLength: 500;
            };
        };
    };
    execute(_toolCallId: string, rawParams: unknown): Promise<import("../format.js").ToolTextResult>;
};
//# sourceMappingURL=topic-create.d.ts.map