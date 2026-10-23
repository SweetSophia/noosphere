import adapter, { server, NoosphereKiloPlugin } from "@sweetsophia/kilocode-noosphere-memory";
import type { Plugin, PluginInput, Hooks } from "@kilocode/plugin";
const entry: Plugin = adapter.server;
const id: string = adapter.id;
void id;
const s: Plugin = server;
const n: Plugin = NoosphereKiloPlugin;
export async function initialize(input: PluginInput): Promise<Hooks> { return entry(input, {}); }
void s; void n;
