#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { NoosphereClient } from "./client.js";
import { resolveNoosphereConfig } from "./config.js";
import { installCodexIntegration } from "./install-codex.js";
import { createNoosphereMcpServer } from "./server.js";
const packageRoot = new URL("../", import.meta.url);
const packageVersion = readPackageVersion();
async function main() {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "install-codex") {
        const result = await installCodexIntegration({
            homeDir: homedir(),
            packageVersion,
            skillSourceFile: fileURLToPath(new URL("skills/noosphere-memory/SKILL.md", packageRoot)),
        });
        process.stdout.write([
            `Noosphere MCP server: ${result.serverAction}`,
            `Noosphere Codex skill: ${result.skillAction}`,
            "Set CODEX_NOOSPHERE_API_KEY in the environment that launches Codex.",
            "The default Noosphere URL is http://127.0.0.1:6578.",
        ].join("\n") + "\n");
        return;
    }
    if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
        printHelp();
        return;
    }
    if (args.length > 0) {
        throw new Error(`Unknown argument: ${args.join(" ")}. Run noosphere-mcp --help.`);
    }
    const config = resolveNoosphereConfig();
    const client = new NoosphereClient(config);
    const server = createNoosphereMcpServer(client, packageVersion);
    await server.connect(new StdioServerTransport());
}
function readPackageVersion() {
    const manifest = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8"));
    if (typeof manifest.version !== "string" || !manifest.version) {
        throw new Error("Package manifest does not contain a valid version.");
    }
    return manifest.version;
}
function printHelp() {
    process.stdout.write(`Noosphere MCP ${packageVersion}\n\n`);
    process.stdout.write("Usage:\n");
    process.stdout.write("  noosphere-mcp                 Start the stdio MCP server\n");
    process.stdout.write("  noosphere-mcp install-codex   Install the Codex MCP launcher and skill\n");
    process.stdout.write("  noosphere-mcp --help          Show this help\n");
}
main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[noosphere-mcp] ${message.slice(0, 2_000)}\n`);
    process.exitCode = 1;
});
//# sourceMappingURL=cli.js.map