import { homedir } from "node:os";
import { join } from "node:path";
import {
  isRecord,
  readBoolean,
  readStringArray,
  redactSecret,
  resolveNoosphereMemoryConfig,
  type ResolvedNoosphereMemoryConfig,
} from "./config.js";
import { NoosphereMemoryClient, type NoosphereStatusResponse } from "./client.js";

const PLUGIN_ID = "noosphere-memory";
const DEFAULT_COMPOSE_FILE = "~/.noosphere/docker-compose.yml";
const DEFAULT_LOG_TAIL = 80;
const VERIFIED_INSTALLER_REF = "27250f4f136002944a141344f6965d37d80d1754";
const VERIFIED_INSTALLER_SHA256 = "10c59f687e895104f189e6bf894aa39044b11925233f1126eabe2800c3b5f122";
const VERIFIED_INSTALLER_URL =
  `https://raw.githubusercontent.com/SweetSophia/noosphere/${VERIFIED_INSTALLER_REF}/install-openclaw.sh`;

export type NoosphereCliCheckStatus = "pass" | "warn" | "fail";

export interface NoosphereCliCheck {
  id: string;
  label: string;
  status: NoosphereCliCheckStatus;
  message: string;
  details?: unknown;
}

export interface NoosphereDoctorReport {
  ok: boolean;
  baseUrl: string;
  apiKeyConfigured: boolean;
  apiKeyRedacted?: string;
  checks: NoosphereCliCheck[];
}

export interface NoosphereStatusReport {
  ok: boolean;
  baseUrl: string;
  apiKeyConfigured: boolean;
  health?: {
    ok: boolean;
    status?: number;
    error?: string;
  };
  memoryStatus?: NoosphereStatusResponse;
}

type FetchLike = typeof fetch;

export interface NoosphereDoctorOptions {
  fetchImpl?: FetchLike;
  client?: Pick<NoosphereMemoryClient, "status">;
}

interface CliCommand {
  command(name: string): CliCommand;
  description(text: string): CliCommand;
  option(
    flags: string,
    description?: string,
    parserOrDefault?: CliOptionParser | unknown,
    defaultValue?: unknown,
  ): CliCommand;
  argument(name: string, description?: string, defaultValue?: unknown): CliCommand;
  action<TArgs extends readonly unknown[]>(handler: CliActionHandler<TArgs>): CliCommand;
}

type CliOptionParser = (value: string) => unknown;
type CliActionHandler<TArgs extends readonly unknown[]> = (...args: TArgs) => void | Promise<void>;

export function getVerifiedInstallerCommands(): string[] {
  return [
    'installer="$(mktemp)"',
    `curl -fsSL ${VERIFIED_INSTALLER_URL} -o "$installer"`,
    `printf '%s  %s\\n' '${VERIFIED_INSTALLER_SHA256}' "$installer" | sha256sum -c -`,
    'bash "$installer" && rm -f "$installer"',
  ];
}

export function registerNoosphereCli(program: CliCommand, rawConfig: unknown, rootConfig: unknown): void {
  const noosphere = program
    .command("noosphere")
    .description("Inspect and operate the Noosphere memory integration");

  noosphere
    .command("status")
    .description("Show Noosphere integration status")
    .option("--json", "Print JSON")
    .action(async (opts: { json?: boolean }) => {
      const report = await buildNoosphereStatusReport(rawConfig, rootConfig);
      printStatusReport(report, Boolean(opts.json));
      if (!report.ok) process.exitCode = 1;
    });

  noosphere
    .command("doctor")
    .description("Run actionable Noosphere/OpenClaw integration checks")
    .option("--json", "Print JSON")
    .action(async (opts: { json?: boolean }) => {
      const report = await buildNoosphereDoctorReport(rawConfig, rootConfig);
      printDoctorReport(report, Boolean(opts.json));
      if (!report.ok) process.exitCode = 1;
    });

  noosphere
    .command("logs")
    .description("Print the Docker Compose command for Noosphere logs")
    .argument("[service]", "Compose service to tail", "app")
    .option("--tail <lines>", "Number of log lines", parsePositiveInteger, DEFAULT_LOG_TAIL)
    .option("--compose-file <path>", "Compose file path", DEFAULT_COMPOSE_FILE)
    .action((service: string, opts: { tail?: number; composeFile?: string }) => {
      const composeFile = expandHome(opts.composeFile ?? DEFAULT_COMPOSE_FILE);
      const tail = opts.tail ?? DEFAULT_LOG_TAIL;
      console.log("Run this on the OpenClaw host to inspect Noosphere logs:");
      console.log(`docker compose -f ${shellQuote(composeFile)} logs --tail ${tail} ${shellQuote(service)}`);
    });

  noosphere
    .command("setup")
    .description("Print the recommended installer command")
    .action(() => {
      console.log("Noosphere setup uses an immutable, checksum-verified installer:");
      for (const command of getVerifiedInstallerCommands()) console.log(command);
      console.log("");
      console.log("After setup, run: openclaw noosphere doctor");
    });

  noosphere
    .command("upgrade")
    .description("Print the recommended upgrade commands")
    .action(() => {
      console.log("Noosphere upgrades must use the immutable, checksum-verified guarded installer:");
      for (const command of getVerifiedInstallerCommands()) console.log(command);
      console.log("");
      console.log("The installer performs the PostgreSQL image transition, backup restore proof, rollback rehearsal, and deployment verification before reporting success.");
      console.log("openclaw noosphere doctor");
    });
}

export async function buildNoosphereStatusReport(
  rawConfig: unknown,
  rootConfig: unknown,
  options: NoosphereDoctorOptions = {},
): Promise<NoosphereStatusReport> {
  const config = resolveNoosphereMemoryConfig(rawConfig, process.env, rootConfig);
  const health = await checkHealthEndpoint(config, options.fetchImpl ?? fetch);
  let memoryStatus: NoosphereStatusResponse | undefined;

  if (config.apiKey) {
    try {
      const client = options.client ?? new NoosphereMemoryClient(config);
      memoryStatus = await client.status();
    } catch {
      // The doctor report includes the actionable API failure. Status stays terse.
    }
  }

  return {
    ok: Boolean(health.ok && config.apiKey && memoryStatus?.ok === true),
    baseUrl: config.baseUrl,
    apiKeyConfigured: Boolean(config.apiKey),
    health,
    memoryStatus,
  };
}

export async function buildNoosphereDoctorReport(
  rawConfig: unknown,
  rootConfig: unknown,
  options: NoosphereDoctorOptions = {},
): Promise<NoosphereDoctorReport> {
  const config = resolveNoosphereMemoryConfig(rawConfig, process.env, rootConfig);
  const checks: NoosphereCliCheck[] = [];
  const fetchImpl = options.fetchImpl ?? fetch;

  checks.push({
    id: "config.baseUrl",
    label: "Plugin baseUrl",
    status: "pass",
    message: config.baseUrl,
  });

  checks.push({
    id: "config.apiKey",
    label: "API key configured",
    status: config.apiKey ? "pass" : "fail",
    message: config.apiKey ? `configured (${redactSecret(config.apiKey)})` : "missing apiKey",
  });

  const autoRecall = readBoolean(isRecord(rawConfig) ? rawConfig.autoRecall : undefined) ?? false;
  checks.push({
    id: "config.autoRecall",
    label: "Plugin autoRecall",
    status: autoRecall ? "pass" : "warn",
    message: autoRecall ? "enabled" : "disabled in plugin config",
  });

  const enabledAgents = readStringArray(isRecord(rawConfig) ? rawConfig.enabledAgents : undefined) ?? [];
  checks.push({
    id: "config.enabledAgents",
    label: "Enabled agents",
    status: "pass",
    message: enabledAgents.length > 0 ? enabledAgents.join(", ") : "all agents (no allowlist configured)",
  });

  const health = await checkHealthEndpoint(config, fetchImpl);
  checks.push({
    id: "http.health",
    label: "Noosphere health endpoint",
    status: health.ok ? "pass" : "fail",
    message: health.ok ? `HTTP ${health.status}` : health.error ?? `HTTP ${health.status ?? "unknown"}`,
  });

  let dbAutoRecall: boolean | undefined;
  if (config.apiKey) {
    try {
      const client = options.client ?? new NoosphereMemoryClient(config);
      const status = await client.status();
      checks.push({
        id: "api.memoryStatus",
        label: "Memory status API",
        status: status.ok ? "pass" : "fail",
        message: status.ok ? "authenticated and responding" : "responded with ok=false",
        details: status,
      });

      const settings = isRecord(status.settings) ? status.settings : {};
      const dbAutoRecallValue = settings.autoRecallEnabled;
      if (typeof dbAutoRecallValue === "boolean") {
        dbAutoRecall = dbAutoRecallValue;
        checks.push({
          id: "settings.autoRecallEnabled",
          label: "DB auto-recall setting",
          status: dbAutoRecallValue ? "pass" : "warn",
          message: dbAutoRecallValue ? "enabled" : "disabled in Noosphere recall settings",
        });
      }
    } catch (error) {
      checks.push({
        id: "api.memoryStatus",
        label: "Memory status API",
        status: "fail",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const allowPromptInjection = readAllowPromptInjection(rootConfig);
  const promptInjectionRequired = dbAutoRecall ?? autoRecall;
  checks.push({
    id: "hooks.allowPromptInjection",
    label: "Prompt injection hook permission",
    status: allowPromptInjection ? "pass" : promptInjectionRequired ? "fail" : "warn",
    message: allowPromptInjection
      ? "plugins.entries.noosphere-memory.hooks.allowPromptInjection=true"
      : promptInjectionRequired
        ? "set plugins.entries.noosphere-memory.hooks.allowPromptInjection=true"
        : "not required while auto-recall is disabled",
  });

  checks.push({
    id: "docker.manualCheck",
    label: "Docker container check",
    status: "warn",
    message: "not executed by plugin CLI for package safety; run: docker compose -f ~/.noosphere/docker-compose.yml ps",
  });

  return {
    ok: checks.every((check) => check.status !== "fail"),
    baseUrl: config.baseUrl,
    apiKeyConfigured: Boolean(config.apiKey),
    ...(config.apiKey ? { apiKeyRedacted: redactSecret(config.apiKey) } : {}),
    checks,
  };
}

function printStatusReport(report: NoosphereStatusReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Noosphere status: ${report.ok ? "OK" : "ATTENTION"}`);
  console.log(`Base URL: ${report.baseUrl}`);
  console.log(`API key: ${report.apiKeyConfigured ? "configured" : "missing"}`);
  if (report.health) {
    console.log(`Health: ${report.health.ok ? "OK" : "FAILED"}${report.health.status ? ` (HTTP ${report.health.status})` : ""}`);
  }
  if (report.memoryStatus) {
    if (report.memoryStatus.ok) {
      const providers = Array.isArray(report.memoryStatus.providers)
        ? report.memoryStatus.providers.length
        : "unknown";
      console.log(`Memory API: OK (${providers} providers)`);
    } else {
      console.log("Memory API: FAILED (ok=false)");
    }
  } else if (report.apiKeyConfigured) {
    console.log("Memory API: FAILED (no authenticated status response)");
  } else {
    console.log("Memory API: skipped (missing API key)");
  }
}

function printDoctorReport(report: NoosphereDoctorReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Noosphere doctor: ${report.ok ? "OK" : "ATTENTION"}`);
  console.log(`Base URL: ${report.baseUrl}`);
  for (const check of report.checks) {
    console.log(`${statusIcon(check.status)} ${check.label}: ${check.message}`);
  }
}

function statusIcon(status: NoosphereCliCheckStatus): string {
  if (status === "pass") return "✓";
  if (status === "warn") return "!";
  return "✗";
}

async function checkHealthEndpoint(
  config: ResolvedNoosphereMemoryConfig,
  fetchImpl: FetchLike,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(`${config.baseUrl}/api/health`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    if (isAbortError(error)) {
      return { ok: false, error: `health check timed out after ${config.timeoutMs}ms` };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}


function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function readAllowPromptInjection(rootConfig: unknown): boolean {
  if (!isRecord(rootConfig)) return false;
  const plugins = rootConfig.plugins;
  if (!isRecord(plugins)) return false;
  const entries = plugins.entries;
  if (!isRecord(entries)) return false;
  const entry = entries[PLUGIN_ID];
  if (!isRecord(entry)) return false;
  const hooks = entry.hooks;
  return isRecord(hooks) && hooks.allowPromptInjection === true;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("value must be a positive integer");
  }
  return parsed;
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
