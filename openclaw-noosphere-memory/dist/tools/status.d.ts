import { NoosphereClientContext } from "../shared-init.js";
export declare function createNoosphereStatusTool(rawConfig: unknown, context?: NoosphereClientContext): {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        additionalProperties: boolean;
        properties: {};
    };
    execute(): Promise<import("../format.js").ToolTextResult>;
};
