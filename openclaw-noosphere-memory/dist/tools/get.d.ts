import { NoosphereClientContext } from "../shared-init.js";
export declare function createNoosphereGetTool(rawConfig: unknown, context?: NoosphereClientContext): {
    name: string;
    label: string;
    description: string;
    parameters: {
        readonly type: "object";
        readonly additionalProperties: false;
        readonly properties: {
            readonly provider: {
                readonly type: "string";
                readonly description: "Provider ID, for example noosphere.";
            };
            readonly id: {
                readonly type: "string";
                readonly description: "Provider-local ID.";
            };
            readonly canonicalRef: {
                readonly type: "string";
                readonly description: "Canonical memory reference, for example noosphere:article:<id>.";
            };
        };
        readonly oneOf: readonly [{
            readonly required: readonly ["canonicalRef"];
            readonly not: {
                readonly anyOf: readonly [{
                    readonly required: readonly ["provider"];
                }, {
                    readonly required: readonly ["id"];
                }];
            };
        }, {
            readonly required: readonly ["provider", "id"];
            readonly not: {
                readonly required: readonly ["canonicalRef"];
            };
        }];
    };
    execute(_toolCallId: string, rawParams: unknown): Promise<import("../format.js").ToolTextResult>;
};
//# sourceMappingURL=get.d.ts.map