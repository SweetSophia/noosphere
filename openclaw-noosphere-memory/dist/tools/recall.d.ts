import { NoosphereClientContext } from "../shared-init.js";
export declare function createNoosphereRecallTool(rawConfig: unknown, context?: NoosphereClientContext): {
    name: string;
    label: string;
    description: string;
    parameters: {
        readonly type: "object";
        readonly additionalProperties: false;
        readonly required: readonly ["query"];
        readonly properties: {
            readonly query: {
                readonly type: "string";
                readonly description: "Recall query string.";
            };
            readonly mode: {
                readonly type: "string";
                readonly enum: readonly ["auto", "inspection"];
            };
            readonly resultCap: {
                readonly type: "number";
                readonly minimum: 1;
                readonly maximum: 10;
                readonly description: "Maximum ranked results to return.";
            };
            readonly tokenBudget: {
                readonly type: "number";
                readonly minimum: 1;
                readonly maximum: 2000;
                readonly description: "Maximum prompt-injection token budget for auto mode.";
            };
            readonly scope: {
                readonly type: "string";
                readonly description: "Optional Noosphere scope hint.";
            };
            readonly providers: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
                readonly description: "Optional provider IDs, for example [\"noosphere\"].";
            };
        };
    };
    execute(_toolCallId: string, rawParams: unknown): Promise<import("../format.js").ToolTextResult>;
};
//# sourceMappingURL=recall.d.ts.map