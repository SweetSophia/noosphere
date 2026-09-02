import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, parse, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import { NOOSPHERE_FORWARDED_ENV_VARS } from "./config.js";

const SERVER_NAME = "noosphere";
const PACKAGE_NAME = "@sweetsophia/noosphere-mcp";
const CODEX_COMMAND_TIMEOUT_MS = 30_000;
const MANAGED_PACKAGE_SPEC =
  /^@sweetsophia\/noosphere-mcp@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CODEX_SERVER_RECORD_KEYS = new Set([
  "name",
  "enabled",
  "transport",
  "enabled_tools",
  "disabled_tools",
  "startup_timeout_sec",
  "tool_timeout_sec",
  "disabled_reason",
  "auth_status",
]);
const CODEX_STDIO_TRANSPORT_KEYS = new Set([
  "type",
  "command",
  "args",
  "env",
  "env_vars",
  "cwd",
]);


export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunCodex = (args: string[]) => CommandResult;

export interface CodexInstallOptions {
  homeDir: string;
  codexHomeDir?: string;
  packageVersion: string;
  skillSourceFile: string;
  runCodex?: RunCodex;
}

export interface CodexInstallResult {
  serverAction: "installed" | "upgraded" | "configured" | "unchanged";
  skillAction: "installed" | "unchanged";
}

interface CodexServerRecord {
  name: string;
  enabled: boolean;
  transport: {
    type: string;
    command: string;
    args: unknown;
    env: unknown;
    env_vars: unknown;
    cwd: unknown;
  };
  enabled_tools: unknown;
  disabled_tools: unknown;
  startup_timeout_sec: unknown;
  tool_timeout_sec: unknown;
  disabled_reason: unknown;
  auth_status?: unknown;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  ctimeNs: bigint;
}

interface ConfigMutationReceipt {
  identity: FileIdentity;
  content: string;
}

interface DirectoryIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
}

export class CodexInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexInstallError";
  }
}

export async function installCodexIntegration(
  options: CodexInstallOptions,
): Promise<CodexInstallResult> {
  const packageSpec = `${PACKAGE_NAME}@${options.packageVersion}`;
  const desiredCommand = "npx";
  const desiredArgs = ["-y", packageSpec];
  const codexHomeDir =
    options.codexHomeDir ?? process.env.CODEX_HOME ?? join(options.homeDir, ".codex");
  const runCodex = options.runCodex ??
    ((args: string[]) => runCodexCommand(args, codexHomeDir));
  assertSafeDirectoryPath(codexHomeDir, "Codex home");
  const existing = inspectServer(runCodex);
  const plannedServerAction = classifyServer(existing, desiredCommand, desiredArgs);
  const codexConfigFile = join(codexHomeDir, "config.toml");
  assertSafeDirectoryPath(codexHomeDir, "Codex home");
  assertRegularFileIfPresent(codexConfigFile, "Codex config");

  assertRegularFileIfPresent(options.skillSourceFile, "Packaged Codex skill");
  const sourceSkill = readFileSync(options.skillSourceFile, "utf8");
  const skillDirectory = join(
    options.homeDir,
    ".agents",
    "skills",
    "noosphere-memory",
  );
  assertSafeSkillDirectoryPath(options.homeDir);
  const skillFile = join(skillDirectory, "SKILL.md");
  assertRegularFileIfPresent(skillFile, "Installed Codex skill");
  const existingSkill = existsSync(skillFile)
    ? readFileSync(skillFile, "utf8")
    : undefined;
  if (existingSkill !== undefined && existingSkill !== sourceSkill) {
    throw new CodexInstallError(
      `Refusing to overwrite modified Codex skill at ${skillFile}. Move it aside or reconcile it manually before rerunning the installer.`,
    );
  }
  const skillAction = existingSkill === sourceSkill ? "unchanged" : "installed";
  assertSafeDirectoryPath(codexHomeDir, "Codex home");
  const originalCodexConfig = existsSync(codexConfigFile)
    ? readFileSync(codexConfigFile, "utf8")
    : undefined;
  const originalCodexConfigMode = existsSync(codexConfigFile)
    ? statSync(codexConfigFile).mode & 0o777
    : undefined;

  let wroteSkill = false;
  let writtenSkillIdentity: FileIdentity | undefined;
  const createdSkillDirectories: DirectoryIdentity[] = [];
  let mutatedServer = false;
  let mutatedCodexConfig = false;
  let configMutationReceipt: ConfigMutationReceipt | undefined;
  try {
    if (skillAction === "installed") {
      createdSkillDirectories.push(...ensureSkillDirectories(options.homeDir));
      assertSafeSkillDirectoryPath(options.homeDir);
      writeTextAtomically(skillFile, sourceSkill, 0o644);
      wroteSkill = true;
      writtenSkillIdentity = readRegularFileIdentity(skillFile, "Installed Codex skill");
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
        throw new CodexInstallError(
          `codex mcp add failed: ${boundedCommandError(add)}`,
        );
      }
    }

    assertSafeDirectoryPath(codexHomeDir, "Codex home");
    mutatedCodexConfig = ensureCodexEnvForwarding(codexConfigFile, (receipt) => {
      mutatedCodexConfig = true;
      configMutationReceipt = receipt;
    });

    const installed = inspectServer(runCodex);
    if (!isExactServer(installed, desiredCommand, desiredArgs, true)) {
      throw new CodexInstallError(
        "Codex MCP readback did not match the expected Noosphere launcher.",
      );
    }

    const serverAction =
      plannedServerAction === "unchanged" && mutatedCodexConfig
        ? "configured"
        : plannedServerAction;
    return { serverAction, skillAction };
  } catch (error) {
    const rollbackErrors: string[] = [];
    let serverRollbackSucceeded = true;
    if (mutatedServer) {
      try {
        assertSafeDirectoryPath(codexHomeDir, "Codex home");
        restoreServer(runCodex, existing, desiredCommand, desiredArgs);
        configMutationReceipt = existsSync(codexConfigFile)
          ? readConfigMutationReceipt(codexConfigFile)
          : undefined;
      } catch (rollbackError) {
        serverRollbackSucceeded = false;
        rollbackErrors.push(
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        );
      }
    }
    // `codex mcp add/remove` mutates config.toml itself. Restore exact original
    // bytes whenever that command was attempted, even if our direct edit did not run.
    if ((mutatedServer || mutatedCodexConfig) && serverRollbackSucceeded) {
      try {
        assertSafeDirectoryPath(codexHomeDir, "Codex home");
        restoreCodexConfig(
          codexConfigFile,
          originalCodexConfig,
          originalCodexConfigMode,
          configMutationReceipt,
        );
      } catch (rollbackError) {
        rollbackErrors.push(
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        );
      }
    }
    if (wroteSkill && existsSync(skillFile)) {
      try {
        assertSafeSkillDirectoryPath(options.homeDir);
        assertRegularFileIfPresent(skillFile, "Installed Codex skill");
        const currentIdentity = readRegularFileIdentity(skillFile, "Installed Codex skill");
        if (!writtenSkillIdentity || !sameFileIdentity(currentIdentity, writtenSkillIdentity)) {
          throw new CodexInstallError(
            `Refusing to remove ${skillFile} during rollback because its file identity changed after installation.`,
          );
        }
        if (readFileSync(skillFile, "utf8") === sourceSkill) {
          unlinkSync(skillFile);
        } else {
          throw new CodexInstallError(
            `Refusing to remove ${skillFile} during rollback because it changed after installation.`,
          );
        }
      } catch (rollbackError) {
        rollbackErrors.push(
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        );
      }
    }
    for (const created of [...createdSkillDirectories].reverse()) {
      if (!existsSync(created.path)) continue;
      try {
        assertSafeSkillDirectoryPath(options.homeDir);
        const current = readDirectoryIdentity(
          created.path,
          "Created Codex skill directory",
        );
        if (current.dev !== created.dev || current.ino !== created.ino) {
          throw new CodexInstallError(
            `Refusing to remove ${created.path} during rollback because its directory identity changed after installation.`,
          );
        }
        rmdirSync(created.path);
      } catch (rollbackError) {
        rollbackErrors.push(
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        );
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new CodexInstallError(
      rollbackErrors.length > 0
        ? `${message} Rollback also failed: ${rollbackErrors.join("; ")}`
        : message,
    );
  }
}

function inspectServer(runCodex: RunCodex): CodexServerRecord | undefined {
  const result = runCodex(["mcp", "get", SERVER_NAME, "--json"]);
  if (
    result.code === 1 &&
    result.stderr.includes(`No MCP server named '${SERVER_NAME}' found`)
  ) {
    return undefined;
  }
  if (result.code !== 0) {
    throw new CodexInstallError(
      `Unable to inspect Codex MCP configuration: ${boundedCommandError(result)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new CodexInstallError(
      "Codex returned invalid JSON while inspecting the Noosphere MCP server.",
    );
  }
  if (!isRecord(parsed)) {
    throw new CodexInstallError(
      "Codex returned an unexpected MCP configuration shape.",
    );
  }
  return parsed as unknown as CodexServerRecord;
}

function classifyServer(
  existing: CodexServerRecord | undefined,
  desiredCommand: string,
  desiredArgs: string[],
): CodexInstallResult["serverAction"] {
  if (!existing) return "installed";
  if (isExactServer(existing, desiredCommand, desiredArgs)) return "unchanged";
  if (isPlainManagedServer(existing)) return "upgraded";
  throw new CodexInstallError(
    "Refusing to overwrite the existing Codex MCP server named 'noosphere' because it is not a plain @sweetsophia/noosphere-mcp launcher. Remove or rename it manually, then rerun the installer.",
  );
}

function isExactServer(
  server: CodexServerRecord | undefined,
  command: string,
  args: string[],
  requireCompleteForwarding = false,
): boolean {
  return Boolean(
    server &&
      isPlainManagedServer(server) &&
      server.transport?.command === command &&
      stringArrayEquals(server.transport.args, args) &&
      (!requireCompleteForwarding || hasExactForwardedEnvVarSet(server.transport.env_vars)),
  );
}

function isPlainManagedServer(server: CodexServerRecord): boolean {
  const transport = server.transport;
  if (
    !hasOnlyKeys(server, CODEX_SERVER_RECORD_KEYS) ||
    !transport ||
    !hasOnlyKeys(transport, CODEX_STDIO_TRANSPORT_KEYS) ||
    server.name !== SERVER_NAME ||
    server.enabled !== true ||
    transport?.type !== "stdio" ||
    transport.command !== "npx" ||
    !Array.isArray(transport.args) ||
    transport.args.length !== 2 ||
    transport.args[0] !== "-y" ||
    typeof transport.args[1] !== "string" ||
    !MANAGED_PACKAGE_SPEC.test(transport.args[1]) ||
    transport.env !== null ||
    transport.cwd !== null ||
    !knownEnvVarList(transport.env_vars) ||
    server.enabled_tools !== null ||
    server.disabled_tools !== null ||
    server.startup_timeout_sec !== null ||
    server.tool_timeout_sec !== null ||
    server.disabled_reason !== null ||
    (server.auth_status !== undefined && server.auth_status !== "unsupported")
  ) {
    return false;
  }
  return true;
}

function ensureCodexEnvForwarding(
  configFile: string,
  recordWrite: (receipt: ConfigMutationReceipt) => void,
): boolean {
  if (!existsSync(configFile)) {
    throw new CodexInstallError(
      `Codex MCP configuration was not written at ${configFile}.`,
    );
  }

  const original = readFileSync(configFile, "utf8");
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = original.endsWith("\n");
  const lines = original.replace(/\r\n/g, "\n").split("\n");
  if (hadTrailingNewline) lines.pop();

  const { sectionStart, sectionEnd } = findNoosphereSectionBounds(lines);

  const envVarLines: number[] = [];
  for (let index = sectionStart + 1; index < sectionEnd; index += 1) {
    if (/^\s*env_vars\s*=/.test(lines[index])) envVarLines.push(index);
  }
  if (envVarLines.length > 1) {
    throw new CodexInstallError(
      "Codex noosphere MCP section contains multiple env_vars assignments.",
    );
  }

  const existingEnvVars = envVarLines.length === 1
    ? parseEnvVarAssignment(lines[envVarLines[0]])
    : [];
  const mergedEnvVars = [
    ...existingEnvVars,
    ...NOOSPHERE_FORWARDED_ENV_VARS.filter((name) => !existingEnvVars.includes(name)),
  ];
  if (
    envVarLines.length === 1 &&
    stringArrayEquals(existingEnvVars, mergedEnvVars)
  ) {
    return false;
  }

  const assignment = `env_vars = ${JSON.stringify(mergedEnvVars)}`;
  if (envVarLines.length === 1) {
    lines[envVarLines[0]] = assignment;
  } else {
    const argsLine = lines.findIndex(
      (line, index) =>
        index > sectionStart && index < sectionEnd && /^\s*args\s*=/.test(line),
    );
    const insertionIndex = argsLine >= 0 ? argsLine + 1 : sectionStart + 1;
    lines.splice(insertionIndex, 0, assignment);
  }

  const updated = lines.join(newline) + (hadTrailingNewline ? newline : "");
  writeTextAtomically(configFile, updated);
  recordWrite(readConfigMutationReceipt(configFile));

  const readback = readFileSync(configFile, "utf8");
  const readbackEnvVars = readNoosphereEnvVarsFromConfig(readback);
  if (!stringArrayEquals(readbackEnvVars, mergedEnvVars)) {
    throw new CodexInstallError(
      "Codex noosphere environment-forwarding readback did not exactly match the intended variable names.",
    );
  }
  return true;
}

export function readNoosphereEnvVarsFromConfig(config: string): string[] {
  const lines = config.replace(/\r\n/g, "\n").split("\n");
  const { sectionStart, sectionEnd } = findNoosphereSectionBounds(lines);
  const assignments = lines.slice(sectionStart + 1, sectionEnd).filter(
    (line) => /^\s*env_vars\s*=/.test(line),
  );
  if (assignments.length !== 1) {
    throw new CodexInstallError(
      "Codex noosphere environment-forwarding readback must contain exactly one env_vars assignment.",
    );
  }
  return parseEnvVarAssignment(assignments[0]);
}

function findNoosphereSectionBounds(lines: string[]): {
  sectionStart: number;
  sectionEnd: number;
} {
  const sectionStarts = lines
    .map((line, index) =>
      line.trim() === `[mcp_servers.${SERVER_NAME}]` ? index : -1)
    .filter((index) => index >= 0);
  if (sectionStarts.length !== 1) {
    throw new CodexInstallError(
      "Codex config must contain exactly one unambiguous [mcp_servers.noosphere] section.",
    );
  }
  const sectionStart = sectionStarts[0];
  let sectionEnd = lines.findIndex(
    (line, index) => index > sectionStart && /^\s*\[/.test(line),
  );
  if (sectionEnd < 0) sectionEnd = lines.length;
  return { sectionStart, sectionEnd };
}

function parseEnvVarAssignment(line: string): string[] {
  const match = /^\s*env_vars\s*=\s*(\[[^\n]*\])\s*$/.exec(line);
  if (!match) {
    throw new CodexInstallError(
      "Codex noosphere env_vars must be a single-line string array before the installer can update it safely.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    throw new CodexInstallError(
      "Codex noosphere env_vars is not a valid string array.",
    );
  }
  if (
    !isStringArray(parsed) ||
    parsed.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
  ) {
    throw new CodexInstallError(
      "Codex noosphere env_vars contains an invalid environment variable name.",
    );
  }
  if (new Set(parsed).size !== parsed.length) {
    throw new CodexInstallError(
      "Codex noosphere env_vars contains duplicate environment variable names.",
    );
  }
  return parsed;
}

function restoreCodexConfig(
  configFile: string,
  original: string | undefined,
  originalMode: number | undefined,
  receipt: ConfigMutationReceipt | undefined,
): void {
  if (original === undefined) {
    if (existsSync(configFile)) {
      assertOwnedConfigMutation(configFile, receipt);
      unlinkSync(configFile);
    }
    return;
  }
  assertRegularFileIfPresent(configFile, "Codex config rollback target");
  if (existsSync(configFile) && readFileSync(configFile, "utf8") === original) {
    if (originalMode !== undefined && receipt) {
      const currentIdentity = readRegularFileIdentity(
        configFile,
        "Codex config rollback target",
      );
      if (
        sameFileIdentity(currentIdentity, receipt.identity) &&
        receipt.content === original
      ) {
        chmodSync(configFile, originalMode);
      }
    }
    return;
  }
  if (existsSync(configFile)) {
    assertOwnedConfigMutation(configFile, receipt);
  }
  writeTextAtomically(configFile, original, 0o600, originalMode);
}

function assertOwnedConfigMutation(
  configFile: string,
  receipt: ConfigMutationReceipt | undefined,
): void {
  if (!receipt) {
    throw new CodexInstallError(
      `Refusing to restore ${configFile} because the installer has no ownership receipt for its current contents.`,
    );
  }
  const currentIdentity = readRegularFileIdentity(
    configFile,
    "Codex config rollback target",
  );
  if (
    !sameFileIdentity(currentIdentity, receipt.identity) ||
    readFileSync(configFile, "utf8") !== receipt.content
  ) {
    throw new CodexInstallError(
      `Refusing to restore ${configFile} because its identity or contents changed after the installer wrote it.`,
    );
  }
}

function writeTextAtomically(
  path: string,
  content: string,
  defaultMode = 0o600,
  modeOverride?: number,
): void {
  assertRegularFileIfPresent(path, "Atomic write target");
  const mode = modeOverride ??
    (existsSync(path) ? statSync(path).mode & 0o777 : defaultMode);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function assertRegularFileIfPresent(path: string, label: string): void {
  let status;
  try {
    status = lstatSync(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new CodexInstallError(
      `${label} at ${path} must be a regular file, not a symlink or special file.`,
    );
  }
}

function readRegularFileIdentity(path: string, label: string): FileIdentity {
  const status = lstatSync(path, { bigint: true });
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new CodexInstallError(
      `${label} at ${path} must be a regular file, not a symlink or special file.`,
    );
  }
  return {
    dev: status.dev,
    ino: status.ino,
    ctimeNs: status.ctimeNs,
  };
}

function readConfigMutationReceipt(configFile: string): ConfigMutationReceipt {
  return {
    identity: readRegularFileIdentity(configFile, "Codex config mutation"),
    content: readFileSync(configFile, "utf8"),
  };
}

function readDirectoryIdentity(path: string, label: string): DirectoryIdentity {
  const status = lstatSync(path, { bigint: true });
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new CodexInstallError(
      `${label} at ${path} must be a real directory, not a symlink or special file.`,
    );
  }
  return { path, dev: status.dev, ino: status.ino };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.ctimeNs === right.ctimeNs;
}

function assertSafeDirectoryPath(path: string, label: string): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const components = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    let status;
    try {
      status = lstatSync(current);
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return;
      throw error;
    }
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new CodexInstallError(
        `${label} at ${path} must use real directory components, not symlinks or special files.`,
      );
    }
  }
}

function assertSafeSkillDirectoryPath(homeDir: string): void {
  assertSafeDirectoryPath(homeDir, "Home directory");
  const directories = [
    join(homeDir, ".agents"),
    join(homeDir, ".agents", "skills"),
    join(homeDir, ".agents", "skills", "noosphere-memory"),
  ];
  for (const directory of directories) {
    let status;
    try {
      status = lstatSync(directory);
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") continue;
      throw error;
    }
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new CodexInstallError(
        `Codex skill directory at ${directory} must be a real directory, not a symlink or special file.`,
      );
    }
  }
}

function ensureSkillDirectories(homeDir: string): DirectoryIdentity[] {
  assertSafeDirectoryPath(homeDir, "Home directory");
  const created: DirectoryIdentity[] = [];
  for (const directory of [
    join(homeDir, ".agents"),
    join(homeDir, ".agents", "skills"),
    join(homeDir, ".agents", "skills", "noosphere-memory"),
  ]) {
    try {
      mkdirSync(directory);
      created.push(
        readDirectoryIdentity(directory, "Created Codex skill directory"),
      );
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
      readDirectoryIdentity(directory, "Codex skill directory");
    }
  }
  return created;
}

function restoreServer(
  runCodex: RunCodex,
  previous: CodexServerRecord | undefined,
  desiredCommand: string,
  desiredArgs: string[],
): void {
  const current = inspectServer(runCodex);
  if (previous && current && samePlainManagedLauncher(current, previous)) return;
  if (current && !isExactServer(current, desiredCommand, desiredArgs)) {
    throw new CodexInstallError(
      "Refusing to roll back the MCP server because its current launcher is not the installer-owned launcher.",
    );
  }

  if (!previous) {
    if (!current) return;
    const removed = runCodex(["mcp", "remove", SERVER_NAME]);
    if (removed.code !== 0) {
      if (inspectServer(runCodex) === undefined) return;
      throw new CodexInstallError(
        `Unable to remove partially installed MCP server: ${boundedCommandError(removed)}`,
      );
    }
    return;
  }

  if (!isPlainManagedServer(previous)) {
    throw new CodexInstallError(
      "Cannot automatically restore a customized pre-existing MCP server.",
    );
  }
  const command = previous.transport?.command;
  const args = previous.transport?.args;
  if (typeof command !== "string" || !isStringArray(args)) {
    throw new CodexInstallError("Previous MCP launcher could not be reconstructed.");
  }
  const restored = runCodex(["mcp", "add", SERVER_NAME, "--", command, ...args]);
  if (restored.code !== 0) {
    const restoredCurrent = inspectServer(runCodex);
    if (restoredCurrent && samePlainManagedLauncher(restoredCurrent, previous)) return;
    throw new CodexInstallError(
      `Unable to restore the previous MCP launcher: ${boundedCommandError(restored)}`,
    );
  }
}

function samePlainManagedLauncher(
  current: CodexServerRecord,
  previous: CodexServerRecord,
): boolean {
  if (!isPlainManagedServer(current) || !isPlainManagedServer(previous)) {
    return false;
  }
  return current.transport?.command === previous.transport?.command &&
    stringArrayEquals(current.transport?.args, previous.transport?.args as string[]);
}

export function runCodexCommand(
  args: string[],
  codexHomeDir: string,
  timeoutMs = CODEX_COMMAND_TIMEOUT_MS,
): CommandResult {
  const result = spawnSync("codex", args, {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: codexHomeDir },
    maxBuffer: 1_000_000,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
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

function boundedCommandError(result: CommandResult): string {
  const message = (result.stderr || result.stdout || `exit ${result.code}`).trim();
  return message.length <= 2_000 ? message : `${message.slice(0, 2_000)}…`;
}

function stringArrayEquals(value: unknown, expected: string[]): boolean {
  return isStringArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index]);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function knownEnvVarList(value: unknown): boolean {
  return isStringArray(value) &&
    new Set(value).size === value.length &&
    value.every((name) => NOOSPHERE_FORWARDED_ENV_VARS.includes(
      name as (typeof NOOSPHERE_FORWARDED_ENV_VARS)[number],
    ));
}

function hasExactForwardedEnvVarSet(value: unknown): boolean {
  return isStringArray(value) &&
    value.length === NOOSPHERE_FORWARDED_ENV_VARS.length &&
    new Set(value).size === value.length &&
    NOOSPHERE_FORWARDED_ENV_VARS.every((name) => value.includes(name));
}

function hasOnlyKeys(value: object, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
