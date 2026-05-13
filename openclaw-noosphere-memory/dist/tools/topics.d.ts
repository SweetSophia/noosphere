import { NoosphereClientContext } from "../shared-init.js";
export declare function createNoosphereTopicsTool(rawConfig: unknown, context?: NoosphereClientContext): {
    name: string;
    label: string;
    description: string;
    parameters: {
        readonly type: "object";
        readonly additionalProperties: false;
        readonly properties: {};
        readonly required: readonly [];
    };
    execute(): Promise<import("../format.js").ToolTextResult>;
};
//# sourceMappingURL=topics.d.ts.map