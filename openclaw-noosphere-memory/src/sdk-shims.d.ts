declare module "openclaw/plugin-sdk/plugin-entry" {
  export interface OpenClawPluginApi {
    pluginConfig?: unknown;
    logger?: {
      warn?: (message: string) => void;
      info?: (message: string) => void;
      debug?: (message: string) => void;
      error?: (message: string) => void;
    };
    registerTool(tool: unknown, options?: unknown): void;
    registerMemoryCorpusSupplement?(supplement: unknown): void;
    on?<TEvent = unknown, TContext = unknown>(
      hookName: "before_prompt_build",
      handler: ((event: TEvent, ctx: TContext) => unknown | Promise<unknown>) & { registrationWarning?: () => void },
      options?: unknown,
    ): void;
  }

  export function definePluginEntry(entry: {
    id: string;
    name: string;
    description: string;
    register(api: OpenClawPluginApi): void;
  }): unknown;
}
