import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
const SERVER_NAME = "noosphere";
const PACKAGE_NAME = "@sweetsophia/noosphere-mcp";
const CODEX_COMMAND_TIMEOUT_MS = 30_000;
const MANAGED_PACKAGE_SPEC = /^@sweetsophia\/noosphere-mcp@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CODEX_SERVER_RECORD_KEYS = new Set([
    "name",
    "enabled",
    "transport",
    "enabled_tools",
    "disabled_tools",
    "startup_timeout_sec",
    "tool_timeout_sec",
    "disabled_reason",
]);
const CODEX_STDIO_TRANSPORT_KEYS = new Set([
    "type",
    "command",
    "args",
    "env",
    "env_vars",
    "cwd",
]);
const FORWARDED_ENV_VARS = [
    "CODEX_NOOSPHERE_API_KEY",
    "CODEX_NOOSPHERE_BASE_URL",
    "CODEX_NOOSPHERE_TRUSTED_ORIGIN",
    "CODEX_NOOSPHERE_TIMEOUT_MS",
    "NOOSPHERE_API_KEY",
    "NOOSPHERE_BASE_URL",
    "NOOSPHERE_TRUSTED_ORIGIN",
    "NOOSPHERE_TIMEOUT_MS",
];
export class CodexInstallError extends Error {
    constructor(message) {
        super(message);
        this.name = "CodexInstallError";
    }
}
export async function installCodexIntegration(options) {
    const runCodex = options.runCodex ?? runCodexCommand;
    const packageSpec = `${PACKAGE_NAME}@${options.packageVersion}`;
    const desiredCommand = "npx";
    const desiredArgs = ["-y", packageSpec];
    const existing = inspectServer(runCodex);
    const plannedServerAction = classifyServer(existing, desiredCommand, desiredArgs);
    const codexHomeDir = options.codexHomeDir ?? process.env.CODEX_HOME ?? join(options.homeDir, ".codex");
    const codexConfigFile = join(codexHomeDir, "config.toml");
    assertRegularFileIfPresent(codexConfigFile, "Codex config");
    assertRegularFileIfPresent(options.skillSourceFile, "Packaged Codex skill");
    const sourceSkill = readFileSync(options.skillSourceFile, "utf8");
    const skillDirectory = join(options.homeDir, ".agents", "skills", "noosphere-memory");
    assertSafeSkillDirectoryPath(options.homeDir);
    const skillFile = join(skillDirectory, "SKILL.md");
    assertRegularFileIfPresent(skillFile, "Installed Codex skill");
    const existingSkill = existsSync(skillFile)
        ? readFileSync(skillFile, "utf8")
        : undefined;
    if (existingSkill !== undefined && existingSkill !== sourceSkill) {
        throw new CodexInstallError(`Refusing to overwrite modified Codex skill at ${skillFile}. Move it aside or reconcile it manually before rerunning the installer.`);
    }
    const skillAction = existingSkill === sourceSkill ? "unchanged" : "installed";
    const originalCodexConfig = existsSync(codexConfigFile)
        ? readFileSync(codexConfigFile, "utf8")
        : undefined;
    let wroteSkill = false;
    let mutatedServer = false;
    let mutatedCodexConfig = false;
    try {
        if (skillAction === "installed") {
            mkdirSync(skillDirectory, { recursive: true });
            assertSafeSkillDirectoryPath(options.homeDir);
            writeTextAtomically(skillFile, sourceSkill, 0o644);
            wroteSkill = true;
            if (readFileSync(skillFile, "utf8") !== sourceSkill) {
                throw new CodexInstallError("Codex skill readback did not match the packaged skill.");
            }
        }
        if (plannedServerAction !== "unchanged") {
            mutatedServer = true;
            const add = runCodex([
                "mcp",
                "add",
                SERVER_NAME,
                "--",
                desiredCommand,
                ...desiredArgs,
            ]);
            if (add.code !== 0) {
                throw new CodexInstallError(`codex mcp add failed: ${boundedCommandError(add)}`);
            }
        }
        mutatedCodexConfig = ensureCodexEnvForwarding(codexConfigFile, () => {
            mutatedCodexConfig = true;
        });
        const installed = inspectServer(runCodex);
        if (!isExactServer(installed, desiredCommand, desiredArgs)) {
            throw new CodexInstallError("Codex MCP readback did not match the expected Noosphere launcher.");
        }
        const serverAction = plannedServerAction === "unchanged" && mutatedCodexConfig
            ? "configured"
            : plannedServerAction;
        return { serverAction, skillAction };
    }
    catch (error) {
        const rollbackErrors = [];
        if (mutatedServer) {
            try {
                restoreServer(runCodex, existing);
            }
            catch (rollbackError) {
                rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
            }
        }
        if (mutatedServer || mutatedCodexConfig) {
            try {
                restoreCodexConfig(codexConfigFile, originalCodexConfig);
            }
            catch (rollbackError) {
                rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
            }
        }
        if (wroteSkill && existsSync(skillFile)) {
            try {
                assertRegularFileIfPresent(skillFile, "Installed Codex skill");
                if (readFileSync(skillFile, "utf8") === sourceSkill) {
                    unlinkSync(skillFile);
                }
                else {
                    throw new CodexInstallError(`Refusing to remove ${skillFile} during rollback because it changed after installation.`);
                }
            }
            catch (rollbackError) {
                rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
            }
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new CodexInstallError(rollbackErrors.length > 0
            ? `${message} Rollback also failed: ${rollbackErrors.join("; ")}`
            : message);
    }
}
function inspectServer(runCodex) {
    const result = runCodex(["mcp", "get", SERVER_NAME, "--json"]);
    if (result.code === 1 &&
        result.stderr.includes(`No MCP server named '${SERVER_NAME}' found`)) {
        return undefined;
    }
    if (result.code !== 0) {
        throw new CodexInstallError(`Unable to inspect Codex MCP configuration: ${boundedCommandError(result)}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(result.stdout);
    }
    catch {
        throw new CodexInstallError("Codex returned invalid JSON while inspecting the Noosphere MCP server.");
    }
    if (!isRecord(parsed)) {
        throw new CodexInstallError("Codex returned an unexpected MCP configuration shape.");
    }
    return parsed;
}
function classifyServer(existing, desiredCommand, desiredArgs) {
    if (!existing)
        return "installed";
    if (isExactServer(existing, desiredCommand, desiredArgs))
        return "unchanged";
    if (isPlainManagedServer(existing))
        return "upgraded";
    throw new CodexInstallError("Refusing to overwrite the existing Codex MCP server named 'noosphere' because it is not a plain @sweetsophia/noosphere-mcp launcher. Remove or rename it manually, then rerun the installer.");
}
function isExactServer(server, command, args) {
    return Boolean(server &&
        isPlainManagedServer(server) &&
        server.transport?.command === command &&
        stringArrayEquals(server.transport.args, args));
}
function isPlainManagedServer(server) {
    const transport = server.transport;
    if (!hasOnlyKeys(server, CODEX_SERVER_RECORD_KEYS) ||
        !transport ||
        !hasOnlyKeys(transport, CODEX_STDIO_TRANSPORT_KEYS) ||
        (server.name !== undefined && server.name !== SERVER_NAME) ||
        server.enabled !== true ||
        transport?.type !== "stdio" ||
        transport.command !== "npx" ||
        !Array.isArray(transport.args) ||
        transport.args.length !== 2 ||
        transport.args[0] !== "-y" ||
        typeof transport.args[1] !== "string" ||
        !MANAGED_PACKAGE_SPEC.test(transport.args[1]) ||
        (transport.env !== null && transport.env !== undefined) ||
        (transport.cwd !== null && transport.cwd !== undefined) ||
        !knownEnvVarList(transport.env_vars) ||
        notNullOrMissing(server.enabled_tools) ||
        notNullOrMissing(server.disabled_tools) ||
        notNullOrMissing(server.startup_timeout_sec) ||
        notNullOrMissing(server.tool_timeout_sec) ||
        notNullOrMissing(server.disabled_reason)) {
        return false;
    }
    return true;
}
function ensureCodexEnvForwarding(configFile, beforeWrite) {
    if (!existsSync(configFile)) {
        throw new CodexInstallError(`Codex MCP configuration was not written at ${configFile}.`);
    }
    const original = readFileSync(configFile, "utf8");
    const newline = original.includes("\r\n") ? "\r\n" : "\n";
    const hadTrailingNewline = original.endsWith("\n");
    const lines = original.replace(/\r\n/g, "\n").split("\n");
    if (hadTrailingNewline)
        lines.pop();
    const sectionStart = lines.findIndex((line) => line.trim() === `[mcp_servers.${SERVER_NAME}]`);
    if (sectionStart < 0) {
        throw new CodexInstallError("Codex config does not contain the expected [mcp_servers.noosphere] section.");
    }
    let sectionEnd = lines.findIndex((line, index) => index > sectionStart && /^\s*\[/.test(line));
    if (sectionEnd < 0)
        sectionEnd = lines.length;
    const envVarLines = [];
    for (let index = sectionStart + 1; index < sectionEnd; index += 1) {
        if (/^\s*env_vars\s*=/.test(lines[index]))
            envVarLines.push(index);
    }
    if (envVarLines.length > 1) {
        throw new CodexInstallError("Codex noosphere MCP section contains multiple env_vars assignments.");
    }
    const existingEnvVars = envVarLines.length === 1
        ? parseEnvVarAssignment(lines[envVarLines[0]])
        : [];
    const mergedEnvVars = [
        ...existingEnvVars,
        ...FORWARDED_ENV_VARS.filter((name) => !existingEnvVars.includes(name)),
    ];
    if (envVarLines.length === 1 &&
        stringArrayEquals(existingEnvVars, mergedEnvVars)) {
        return false;
    }
    const assignment = `env_vars = ${JSON.stringify(mergedEnvVars)}`;
    if (envVarLines.length === 1) {
        lines[envVarLines[0]] = assignment;
    }
    else {
        const argsLine = lines.findIndex((line, index) => index > sectionStart && index < sectionEnd && /^\s*args\s*=/.test(line));
        const insertionIndex = argsLine >= 0 ? argsLine + 1 : sectionStart + 1;
        lines.splice(insertionIndex, 0, assignment);
    }
    const updated = lines.join(newline) + (hadTrailingNewline ? newline : "");
    beforeWrite();
    writeTextAtomically(configFile, updated);
    const readback = readFileSync(configFile, "utf8");
    if (!FORWARDED_ENV_VARS.every((name) => readback.includes(`"${name}"`))) {
        throw new CodexInstallError("Codex environment-forwarding readback did not contain every required variable name.");
    }
    return true;
}
function parseEnvVarAssignment(line) {
    const match = /^\s*env_vars\s*=\s*(\[[^\n]*\])\s*$/.exec(line);
    if (!match) {
        throw new CodexInstallError("Codex noosphere env_vars must be a single-line string array before the installer can update it safely.");
    }
    let parsed;
    try {
        parsed = JSON.parse(match[1]);
    }
    catch {
        throw new CodexInstallError("Codex noosphere env_vars is not a valid string array.");
    }
    if (!isStringArray(parsed) ||
        parsed.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
        throw new CodexInstallError("Codex noosphere env_vars contains an invalid environment variable name.");
    }
    return [...new Set(parsed)];
}
function restoreCodexConfig(configFile, original) {
    if (original === undefined) {
        if (existsSync(configFile))
            unlinkSync(configFile);
        return;
    }
    writeTextAtomically(configFile, original);
}
function writeTextAtomically(path, content, defaultMode = 0o600) {
    assertRegularFileIfPresent(path, "Atomic write target");
    const mode = existsSync(path) ? statSync(path).mode & 0o777 : defaultMode;
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, content, { encoding: "utf8", mode });
        renameSync(temporary, path);
    }
    finally {
        if (existsSync(temporary))
            unlinkSync(temporary);
    }
}
function assertRegularFileIfPresent(path, label) {
    let status;
    try {
        status = lstatSync(path);
    }
    catch (error) {
        if (isRecord(error) && error.code === "ENOENT")
            return;
        throw error;
    }
    if (status.isSymbolicLink() || !status.isFile()) {
        throw new CodexInstallError(`${label} at ${path} must be a regular file, not a symlink or special file.`);
    }
}
function assertSafeSkillDirectoryPath(homeDir) {
    const directories = [
        join(homeDir, ".agents"),
        join(homeDir, ".agents", "skills"),
        join(homeDir, ".agents", "skills", "noosphere-memory"),
    ];
    for (const directory of directories) {
        let status;
        try {
            status = lstatSync(directory);
        }
        catch (error) {
            if (isRecord(error) && error.code === "ENOENT")
                continue;
            throw error;
        }
        if (status.isSymbolicLink() || !status.isDirectory()) {
            throw new CodexInstallError(`Codex skill directory at ${directory} must be a real directory, not a symlink or special file.`);
        }
    }
}
function restoreServer(runCodex, previous) {
    if (!previous) {
        const removed = runCodex(["mcp", "remove", SERVER_NAME]);
        if (removed.code !== 0) {
            if (inspectServer(runCodex) === undefined)
                return;
            throw new CodexInstallError(`Unable to remove partially installed MCP server: ${boundedCommandError(removed)}`);
        }
        return;
    }
    if (!isPlainManagedServer(previous)) {
        throw new CodexInstallError("Cannot automatically restore a customized pre-existing MCP server.");
    }
    const command = previous.transport?.command;
    const args = previous.transport?.args;
    if (typeof command !== "string" || !isStringArray(args)) {
        throw new CodexInstallError("Previous MCP launcher could not be reconstructed.");
    }
    const restored = runCodex(["mcp", "add", SERVER_NAME, "--", command, ...args]);
    if (restored.code !== 0) {
        const current = inspectServer(runCodex);
        if (current && samePlainManagedServer(current, previous))
            return;
        throw new CodexInstallError(`Unable to restore the previous MCP launcher: ${boundedCommandError(restored)}`);
    }
}
function samePlainManagedServer(current, previous) {
    if (!isPlainManagedServer(current) || !isPlainManagedServer(previous)) {
        return false;
    }
    const previousEnvVars = isStringArray(previous.transport?.env_vars)
        ? previous.transport.env_vars
        : [];
    return current.transport?.command === previous.transport?.command &&
        stringArrayEquals(current.transport?.args, previous.transport?.args) &&
        stringArrayEquals(current.transport?.env_vars, previousEnvVars);
}
function runCodexCommand(args) {
    const result = spawnSync("codex", args, {
        encoding: "utf8",
        maxBuffer: 1_000_000,
        timeout: CODEX_COMMAND_TIMEOUT_MS,
    });
    if (result.error) {
        return { code: -1, stdout: result.stdout ?? "", stderr: result.error.message };
    }
    return {
        code: result.status ?? -1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
    };
}
function boundedCommandError(result) {
    const message = (result.stderr || result.stdout || `exit ${result.code}`).trim();
    return message.length <= 2_000 ? message : `${message.slice(0, 2_000)}…`;
}
function stringArrayEquals(value, expected) {
    return isStringArray(value) &&
        value.length === expected.length &&
        value.every((entry, index) => entry === expected[index]);
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
function knownEnvVarList(value) {
    return value === undefined ||
        (isStringArray(value) &&
            value.every((name) => FORWARDED_ENV_VARS.includes(name)));
}
function notNullOrMissing(value) {
    return value !== null && value !== undefined;
}
function hasOnlyKeys(value, allowed) {
    return Object.keys(value).every((key) => allowed.has(key));
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=install-codex.js.map