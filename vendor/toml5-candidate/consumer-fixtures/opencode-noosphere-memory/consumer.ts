import adapter, { server, NoosphereOpencodePlugin } from "@sweetsophia/opencode-noosphere-memory";
import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
const entry: Plugin = adapter;
const s: Plugin = server;
const n: Plugin = NoosphereOpencodePlugin;
export async function initialize(input: PluginInput): Promise<Hooks> { return entry(input, {}); }
void s; void n;
