declare module "openclaw/plugin-sdk/plugin-entry" {
  export interface OpenClawPluginApi {
    pluginConfig?: unknown;
    registerTool(tool: unknown, options?: unknown): void;
  }

  export function definePluginEntry(entry: {
    id: string;
    name: string;
    description: string;
    register(api: OpenClawPluginApi): void;
  }): unknown;
}
