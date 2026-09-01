import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  CodexInstallError,
  installCodexIntegration,
  type CommandResult,
  type RunCodex,
} from "../src/install-codex.js";

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

interface StoredServer {
  enabled: boolean;
  transport: {
    type: "stdio";
    command: string;
    args: string[];
    env: null;
    env_vars: string[];
    cwd: null;
  };
  enabled_tools: null;
  disabled_tools: null;
  startup_timeout_sec: number | null;
  tool_timeout_sec: number | null;
  disabled_reason: string | null;
}

function server(
  command: string,
  args: string[],
  envVars: string[] = [],
): StoredServer {
  return {
    enabled: true,
    transport: {
      type: "stdio",
      command,
      args,
      env: null,
      env_vars: envVars,
      cwd: null,
    },
    enabled_tools: null,
    disabled_tools: null,
    startup_timeout_sec: null,
    tool_timeout_sec: null,
    disabled_reason: null,
  };
}

function fakeCodex(
  configFile: string,
  initial?: StoredServer,
  addFailure: false | "before" | "after" = false,
): {
  run: RunCodex;
  calls: string[][];
  get current(): StoredServer | undefined;
} {
  let current = initial;
  const calls: string[][] = [];
  if (current) writeFakeConfig(configFile, current);

  return {
    calls,
    get current() {
      return current;
    },
    run(args): CommandResult {
      calls.push([...args]);
      if (args.join(" ") === "mcp get noosphere --json") {
        if (current && existsSync(configFile)) {
          current.transport.env_vars = readForwardedEnvVars(configFile);
        }
        return current
          ? {
              code: 0,
              stdout: JSON.stringify({ name: "noosphere", ...current }),
              stderr: "",
            }
          : {
              code: 1,
              stdout: "",
              stderr: "Error: No MCP server named 'noosphere' found.",
            };
      }
      if (args[0] === "mcp" && args[1] === "add") {
        if (addFailure === "before") {
          return { code: 1, stdout: "", stderr: "synthetic add failure" };
        }
        const separator = args.indexOf("--");
        current = server(args[separator + 1], args.slice(separator + 2));
        writeFakeConfig(configFile, current);
        if (addFailure === "after") {
          return { code: 1, stdout: "", stderr: "synthetic post-write failure" };
        }
        return {
          code: 0,
          stdout: "Added global MCP server 'noosphere'.",
          stderr: "",
        };
      }
      if (args.join(" ") === "mcp remove noosphere") {
        current = undefined;
        if (existsSync(configFile)) unlinkSync(configFile);
        return { code: 0, stdout: "Removed.", stderr: "" };
      }
      return {
        code: 2,
        stdout: "",
        stderr: `Unexpected args: ${args.join(" ")}`,
      };
    },
  };
}

function writeFakeConfig(configFile: string, value: StoredServer): void {
  mkdirSync(dirname(configFile), { recursive: true });
  const envVars = value.transport.env_vars.length > 0
    ? `env_vars = ${JSON.stringify(value.transport.env_vars)}\n`
    : "";
  writeFileSync(
    configFile,
    `[mcp_servers.noosphere]\ncommand = ${JSON.stringify(value.transport.command)}\nargs = ${JSON.stringify(value.transport.args)}\n${envVars}`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function readForwardedEnvVars(configFile: string): string[] {
  const match = /^env_vars\s*=\s*(\[[^\n]*\])$/m.exec(
    readFileSync(configFile, "utf8"),
  );
  return match ? JSON.parse(match[1]) as string[] : [];
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "noosphere-codex-installer-"));
  const home = join(root, "home");
  const codexHome = join(root, "codex-home");
  const configFile = join(codexHome, "config.toml");
  const source = join(root, "SKILL.md");
  mkdirSync(home);
  mkdirSync(codexHome);
  writeFileSync(
    source,
    "---\nname: noosphere-memory\n---\nUse Noosphere.\n",
    "utf8",
  );
  return { root, home, codexHome, configFile, source };
}

function installOptions(
  value: ReturnType<typeof fixture>,
  runCodex: RunCodex,
) {
  return {
    homeDir: value.home,
    codexHomeDir: value.codexHome,
    packageVersion: "1.13.1",
    skillSourceFile: value.source,
    runCodex,
  };
}

test("installs a value-free launcher, environment forwarding, and the Codex skill", async () => {
  const value = fixture();
  const codex = fakeCodex(value.configFile);

  const result = await installCodexIntegration(installOptions(value, codex.run));

  assert.equal(result.serverAction, "installed");
  assert.equal(result.skillAction, "installed");
  assert.deepEqual(codex.current?.transport, {
    type: "stdio",
    command: "npx",
    args: ["-y", "@sweetsophia/noosphere-mcp@1.13.1"],
    env: null,
    env_vars: FORWARDED_ENV_VARS,
    cwd: null,
  });
  assert.equal(
    readFileSync(
      join(value.home, ".agents", "skills", "noosphere-memory", "SKILL.md"),
      "utf8",
    ),
    readFileSync(value.source, "utf8"),
  );
  const config = readFileSync(value.configFile, "utf8");
  assert.ok(FORWARDED_ENV_VARS.every((name) => config.includes(`"${name}"`)));
  assert.ok(codex.calls.every((args) => !args.join(" ").includes("API_KEY")));
  assert.ok(!config.includes("synthetic-secret-value"));
});

test("is idempotent for the exact launcher, forwarding, and skill", async () => {
  const value = fixture();
  const destination = join(
    value.home,
    ".agents",
    "skills",
    "noosphere-memory",
  );
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, "SKILL.md"), readFileSync(value.source));
  const codex = fakeCodex(
    value.configFile,
    server(
      "npx",
      ["-y", "@sweetsophia/noosphere-mcp@1.13.1"],
      FORWARDED_ENV_VARS,
    ),
  );

  const result = await installCodexIntegration(installOptions(value, codex.run));

  assert.deepEqual(result, {
    serverAction: "unchanged",
    skillAction: "unchanged",
  });
  assert.equal(codex.calls.filter((args) => args[1] === "add").length, 0);
});

test("configures forwarding on an exact launcher that lacks it", async () => {
  const value = fixture();
  const codex = fakeCodex(
    value.configFile,
    server("npx", ["-y", "@sweetsophia/noosphere-mcp@1.13.1"]),
  );

  const result = await installCodexIntegration(installOptions(value, codex.run));

  assert.equal(result.serverAction, "configured");
  assert.equal(codex.calls.filter((args) => args[1] === "add").length, 0);
  assert.deepEqual(readForwardedEnvVars(value.configFile), FORWARDED_ENV_VARS);
});

test("refuses an exact launcher with unapproved environment forwarding", async () => {
  const value = fixture();
  const custom = fakeCodex(
    value.configFile,
    server(
      "npx",
      ["-y", "@sweetsophia/noosphere-mcp@1.13.1"],
      ["AWS_SECRET_ACCESS_KEY"],
    ),
  );

  await assert.rejects(
    () => installCodexIntegration(installOptions(value, custom.run)),
    (error: unknown) =>
      error instanceof CodexInstallError &&
      /Refusing to overwrite/.test(error.message),
  );
  assert.deepEqual(readForwardedEnvVars(value.configFile), [
    "AWS_SECRET_ACCESS_KEY",
  ]);
  assert.equal(custom.calls.some((args) => args[1] === "add"), false);
});

test("upgrades only a plain launcher managed by this package", async () => {
  const value = fixture();
  const codex = fakeCodex(
    value.configFile,
    server(
      "npx",
      ["-y", "@sweetsophia/noosphere-mcp@1.12.0"],
      FORWARDED_ENV_VARS,
    ),
  );

  const result = await installCodexIntegration(installOptions(value, codex.run));

  assert.equal(result.serverAction, "upgraded");
  assert.deepEqual(codex.current?.transport.args, [
    "-y",
    "@sweetsophia/noosphere-mcp@1.13.1",
  ]);
  assert.deepEqual(codex.current?.transport.env_vars, FORWARDED_ENV_VARS);
});

test("refuses to upgrade a managed launcher with custom Codex settings", async () => {
  const value = fixture();
  const customized = server(
    "npx",
    ["-y", "@sweetsophia/noosphere-mcp@1.12.0"],
    FORWARDED_ENV_VARS,
  );
  customized.startup_timeout_sec = 45;
  const codex = fakeCodex(value.configFile, customized);

  await assert.rejects(
    () => installCodexIntegration(installOptions(value, codex.run)),
    /not a plain @sweetsophia\/noosphere-mcp launcher/,
  );
  assert.equal(codex.calls.some((args) => args[1] === "add"), false);
  assert.equal(codex.current?.startup_timeout_sec, 45);
});

test("refuses to upgrade a managed launcher with unknown Codex settings", async () => {
  const value = fixture();
  const customized = server(
    "npx",
    ["-y", "@sweetsophia/noosphere-mcp@1.12.0"],
    FORWARDED_ENV_VARS,
  ) as StoredServer & { future_setting?: number };
  customized.future_setting = 1;
  const codex = fakeCodex(value.configFile, customized);

  await assert.rejects(
    () => installCodexIntegration(installOptions(value, codex.run)),
    /not a plain @sweetsophia\/noosphere-mcp launcher/,
  );
  assert.equal(codex.calls.some((args) => args[1] === "add"), false);
  assert.equal(customized.future_setting, 1);
});

test("refuses to overwrite an unrelated noosphere server or a modified skill", async () => {
  const first = fixture();
  const conflictingServer = fakeCodex(
    first.configFile,
    server("node", ["/custom/noosphere.js"]),
  );
  await assert.rejects(
    () => installCodexIntegration(installOptions(first, conflictingServer.run)),
    (error: unknown) =>
      error instanceof CodexInstallError &&
      /Refusing to overwrite/.test(error.message),
  );
  assert.equal(
    existsSync(
      join(first.home, ".agents", "skills", "noosphere-memory", "SKILL.md"),
    ),
    false,
  );

  const second = fixture();
  const destination = join(
    second.home,
    ".agents",
    "skills",
    "noosphere-memory",
  );
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, "SKILL.md"), "locally modified\n");
  const absentServer = fakeCodex(second.configFile);
  await assert.rejects(
    () => installCodexIntegration(installOptions(second, absentServer.run)),
    /modified Codex skill/,
  );
  assert.equal(absentServer.calls.some((args) => args[1] === "add"), false);
});

test("refuses symlinked durable installer files before mutation", async () => {
  const skillCase = fixture();
  const skillDirectory = join(
    skillCase.home,
    ".agents",
    "skills",
    "noosphere-memory",
  );
  mkdirSync(skillDirectory, { recursive: true });
  symlinkSync(skillCase.source, join(skillDirectory, "SKILL.md"));
  const absentServer = fakeCodex(skillCase.configFile);

  await assert.rejects(
    () => installCodexIntegration(installOptions(skillCase, absentServer.run)),
    /regular file, not a symlink/,
  );
  assert.equal(absentServer.calls.some((args) => args[1] === "add"), false);

  const configCase = fixture();
  const exactServer = fakeCodex(
    configCase.configFile,
    server(
      "npx",
      ["-y", "@sweetsophia/noosphere-mcp@1.13.1"],
      FORWARDED_ENV_VARS,
    ),
  );
  const realConfig = `${configCase.configFile}.real`;
  renameSync(configCase.configFile, realConfig);
  symlinkSync(realConfig, configCase.configFile);

  await assert.rejects(
    () => installCodexIntegration(installOptions(configCase, exactServer.run)),
    /regular file, not a symlink/,
  );
  assert.equal(exactServer.calls.some((args) => args[1] === "add"), false);
});

test("rolls back a newly written skill when codex mcp add fails", async () => {
  const value = fixture();
  const codex = fakeCodex(value.configFile, undefined, "before");

  await assert.rejects(
    () => installCodexIntegration(installOptions(value, codex.run)),
    /synthetic add failure/,
  );
  assert.equal(
    existsSync(
      join(value.home, ".agents", "skills", "noosphere-memory", "SKILL.md"),
    ),
    false,
  );
});

test("rolls back a server that mutates before codex reports add failure", async () => {
  const value = fixture();
  const codex = fakeCodex(value.configFile, undefined, "after");

  await assert.rejects(
    () => installCodexIntegration(installOptions(value, codex.run)),
    /synthetic post-write failure/,
  );
  assert.equal(codex.current, undefined);
  assert.equal(existsSync(value.configFile), false);
  assert.equal(
    existsSync(join(value.home, ".agents", "skills", "noosphere-memory", "SKILL.md")),
    false,
  );
});

test("does not delete a concurrently replaced skill during rollback", async () => {
  const value = fixture();
  const codex = fakeCodex(value.configFile);
  const skillFile = join(
    value.home,
    ".agents",
    "skills",
    "noosphere-memory",
    "SKILL.md",
  );
  const replacement = "---\nname: user-owned\n---\nDo not delete.\n";
  const run: RunCodex = (args) => {
    if (args[0] === "mcp" && args[1] === "add") {
      writeFileSync(skillFile, replacement, "utf8");
      return { code: 1, stdout: "", stderr: "failure after skill replacement" };
    }
    return codex.run(args);
  };

  await assert.rejects(
    () => installCodexIntegration(installOptions(value, run)),
    /failure after skill replacement/,
  );
  assert.equal(readFileSync(skillFile, "utf8"), replacement);
});

test("refuses a symlinked Codex skill directory before mutation", async () => {
  const value = fixture();
  const skillsRoot = join(value.home, ".agents", "skills");
  const outside = join(value.root, "outside");
  mkdirSync(skillsRoot, { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, join(skillsRoot, "noosphere-memory"), "dir");
  const codex = fakeCodex(value.configFile);

  await assert.rejects(
    () => installCodexIntegration(installOptions(value, codex.run)),
    /skill directory.*symlink/i,
  );
  assert.equal(codex.calls.some((args) => args[1] === "add"), false);
  assert.equal(existsSync(join(outside, "SKILL.md")), false);
});
