import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";

import { NOOSPHERE_FORWARDED_ENV_VARS } from "../src/config.js";

import {
  CodexInstallError,
  installCodexIntegration,
  readNoosphereEnvVarsFromConfig,
  runCodexCommand,
  type CommandResult,
  type RunCodex,
} from "../src/install-codex.js";

const FORWARDED_ENV_VARS = [...NOOSPHERE_FORWARDED_ENV_VARS];

interface StoredServer {
  name: "noosphere";
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
  auth_status: "unsupported";
}

function server(
  command: string,
  args: string[],
  envVars: string[] = [],
): StoredServer {
  return {
    name: "noosphere",
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
    auth_status: "unsupported",
  };
}

function fakeCodex(
  configFile: string,
  initial?: StoredServer,
  addFailure: false | "before" | "after" = false,
  readEnvVars: (configFile: string) => string[] = readForwardedEnvVars,
  onAddFailureAfterMutation?: () => void,
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
          current.transport.env_vars = readEnvVars(configFile);
        }
        return current
          ? {
              code: 0,
              stdout: JSON.stringify(current),
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
          onAddFailureAfterMutation?.();
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
  try {
    return readNoosphereEnvVarsFromConfig(readFileSync(configFile, "utf8"));
  } catch {
    return [];
  }
}

function readLastNoosphereEnvVars(configFile: string): string[] {
  const config = readFileSync(configFile, "utf8");
  const marker = "[mcp_servers.noosphere]";
  const sectionStart = config.lastIndexOf(marker);
  if (sectionStart < 0) return [];
  const match = /^env_vars\s*=\s*(\[[^\n]*\])$/m.exec(config.slice(sectionStart));
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

test("reads environment forwarding only from the noosphere MCP section", () => {
  const config = [
    "# unrelated: \"CODEX_NOOSPHERE_API_KEY\"",
    "[mcp_servers.other]",
    `env_vars = ${JSON.stringify(FORWARDED_ENV_VARS)}`,
    "[mcp_servers.noosphere]",
    'env_vars = ["NOOSPHERE_API_KEY"]',
    "",
  ].join("\n");

  assert.deepEqual(readNoosphereEnvVarsFromConfig(config), ["NOOSPHERE_API_KEY"]);
  assert.throws(
    () => readNoosphereEnvVarsFromConfig(
      `[mcp_servers.other]\nenv_vars = ${JSON.stringify(FORWARDED_ENV_VARS)}\n`,
    ),
    /must contain exactly one unambiguous \[mcp_servers\.noosphere\] section/,
  );
});

test("refuses a symlinked Codex home before inspection or mutation", async () => {
  const value = fixture();
  const externalCodexHome = join(value.root, "external-codex-home");
  renameSync(value.codexHome, externalCodexHome);
  symlinkSync(externalCodexHome, value.codexHome, "dir");
  const codex = fakeCodex(
    value.configFile,
    server("npx", ["-y", "@sweetsophia/noosphere-mcp@1.13.1"]),
  );
  const externalConfig = join(externalCodexHome, "config.toml");
  const before = readFileSync(externalConfig, "utf8");

  await assert.rejects(
    installCodexIntegration(installOptions(value, codex.run)),
    /Codex home.*real directory/,
  );

  assert.deepEqual(codex.calls, []);
  assert.equal(readFileSync(externalConfig, "utf8"), before);
  assert.equal(
    existsSync(join(value.home, ".agents", "skills", "noosphere-memory", "SKILL.md")),
    false,
  );
});

test("default Codex runner binds the explicitly selected Codex home", async () => {
  const value = fixture();
  const binDirectory = join(value.root, "bin");
  const codexFixture = join(binDirectory, "codex-fixture.mjs");
  const codexExecutable = join(
    binDirectory,
    process.platform === "win32" ? "codex.cmd" : "codex",
  );
  mkdirSync(binDirectory);
  writeFileSync(
    codexFixture,
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'fs.writeFileSync(path.join(process.env.CODEX_HOME, "seen-home"), process.env.CODEX_HOME);',
      'process.stderr.write("synthetic inspect failure\\n");',
      "process.exitCode = 2;",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    codexExecutable,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${codexFixture}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${codexFixture}" "$@"\n`,
    "utf8",
  );
  chmodSync(codexExecutable, 0o755);
  const previousPath = process.env.PATH;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.PATH = `${binDirectory}${delimiter}${previousPath ?? ""}`;
  process.env.CODEX_HOME = join(value.root, "wrong-codex-home");
  try {
    await assert.rejects(
      () => installCodexIntegration({
        homeDir: value.home,
        codexHomeDir: value.codexHome,
        packageVersion: "1.13.1",
        skillSourceFile: value.source,
      }),
      /synthetic inspect failure/,
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
  assert.equal(
    readFileSync(join(value.codexHome, "seen-home"), "utf8"),
    value.codexHome,
  );
});

test("default Codex runner enforces a hard subprocess deadline", {
  skip: process.platform === "win32",
}, () => {
  const value = fixture();
  const binDirectory = join(value.root, "bin");
  const codexExecutable = join(binDirectory, "codex");
  mkdirSync(binDirectory);
  writeFileSync(
    codexExecutable,
    [
      "#!/usr/bin/env node",
      'process.on("SIGTERM", () => {',
      "  setTimeout(() => process.exit(0), 750);",
      "});",
      "setInterval(() => {}, 1_000);",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(codexExecutable, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDirectory}${delimiter}${previousPath ?? ""}`;
  try {
    const startedAt = Date.now();
    const result = runCodexCommand([], value.codexHome, 50);
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.code, -1);
    assert.ok(elapsedMs < 500, `Codex timeout took ${elapsedMs} ms`);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("rolls back when a multiline TOML string mimics the noosphere section", async () => {
  const value = fixture();
  const codex = fakeCodex(
    value.configFile,
    server("npx", ["-y", "@sweetsophia/noosphere-mcp@1.13.1"]),
    false,
    readLastNoosphereEnvVars,
  );
  const original = [
    'model_instructions = """',
    "[mcp_servers.noosphere]",
    'text = "not a real table"',
    '"""',
    "",
    "[mcp_servers.noosphere]",
    'command = "npx"',
    'args = ["-y", "@sweetsophia/noosphere-mcp@1.13.1"]',
    "",
  ].join("\n");
  writeFileSync(value.configFile, original, "utf8");

  await assert.rejects(
    installCodexIntegration(installOptions(value, codex.run)),
    /noosphere.*section|readback/i,
  );
  assert.equal(readFileSync(value.configFile, "utf8"), original);
  assert.equal(
    existsSync(join(value.home, ".agents", "skills", "noosphere-memory", "SKILL.md")),
    false,
  );
});

test("refuses duplicate forwarded environment names without changing state", async () => {
  const value = fixture();
  const duplicateEnvVars = [...FORWARDED_ENV_VARS, FORWARDED_ENV_VARS[0]];
  const codex = fakeCodex(
    value.configFile,
    server("npx", ["-y", "@sweetsophia/noosphere-mcp@1.13.1"], duplicateEnvVars),
  );
  const before = readFileSync(value.configFile, "utf8");

  await assert.rejects(
    installCodexIntegration(installOptions(value, codex.run)),
    /duplicate|not a plain/i,
  );
  assert.equal(readFileSync(value.configFile, "utf8"), before);
  assert.equal(
    existsSync(join(value.home, ".agents", "skills", "noosphere-memory", "SKILL.md")),
    false,
  );
});

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

test("accepts Codex stdio readback that omits optional auth_status", async () => {
  const value = fixture();
  const destination = join(
    value.home,
    ".agents",
    "skills",
    "noosphere-memory",
  );
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, "SKILL.md"), readFileSync(value.source));
  const current = server(
    "npx",
    ["-y", "@sweetsophia/noosphere-mcp@1.13.1"],
    FORWARDED_ENV_VARS,
  );
  delete (current as { auth_status?: unknown }).auth_status;
  const codex = fakeCodex(value.configFile, current);

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

test("refuses managed readback when required Codex metadata is missing", async () => {
  const missingFields: Array<{
    name: string;
    remove: (value: StoredServer) => void;
  }> = [
    { name: "name", remove: (value) => { delete (value as unknown as Record<string, unknown>).name; } },
    { name: "transport.env", remove: (value) => { delete (value.transport as unknown as Record<string, unknown>).env; } },
    { name: "transport.cwd", remove: (value) => { delete (value.transport as unknown as Record<string, unknown>).cwd; } },
    ...[
      "enabled_tools",
      "disabled_tools",
      "startup_timeout_sec",
      "tool_timeout_sec",
      "disabled_reason",
    ].map((name) => ({
      name,
      remove: (value: StoredServer) => {
        delete (value as unknown as Record<string, unknown>)[name];
      },
    })),
  ];

  for (const missing of missingFields) {
    const value = fixture();
    const incomplete = server(
      "npx",
      ["-y", "@sweetsophia/noosphere-mcp@1.13.1"],
      FORWARDED_ENV_VARS,
    );
    missing.remove(incomplete);
    const codex = fakeCodex(value.configFile, incomplete);

    await assert.rejects(
      () => installCodexIntegration(installOptions(value, codex.run)),
      /not a plain @sweetsophia\/noosphere-mcp launcher/,
      missing.name,
    );
    assert.equal(codex.calls.some((args) => args[1] === "add"), false, missing.name);
  }
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
  assert.equal(existsSync(join(value.home, ".agents")), false);
});

test("refuses managed readback when transport env_vars is missing", async () => {
  const value = fixture();
  const incomplete = server(
    "npx",
    ["-y", "@sweetsophia/noosphere-mcp@1.13.1"],
    FORWARDED_ENV_VARS,
  );
  writeFakeConfig(value.configFile, incomplete);
  delete (incomplete.transport as unknown as Record<string, unknown>).env_vars;
  const calls: string[][] = [];
  const run: RunCodex = (args) => {
    calls.push([...args]);
    return {
      code: 0,
      stdout: JSON.stringify(incomplete),
      stderr: "",
    };
  };

  await assert.rejects(
    () => installCodexIntegration(installOptions(value, run)),
    /not a plain @sweetsophia\/noosphere-mcp launcher/,
  );
  assert.equal(calls.length, 1);
});

test("rollback preserves the original Codex config mode", async () => {
  const value = fixture();
  const codex = fakeCodex(
    value.configFile,
    server(
      "npx",
      ["-y", "@sweetsophia/noosphere-mcp@1.12.0"],
      FORWARDED_ENV_VARS,
    ),
    "after",
    readForwardedEnvVars,
    () => chmodSync(value.configFile, 0o600),
  );
  chmodSync(value.configFile, 0o640);

  await assert.rejects(
    () => installCodexIntegration(installOptions(value, codex.run)),
    /synthetic post-write failure/,
  );
  assert.equal(lstatSync(value.configFile).mode & 0o777, 0o640);
});

test("atomic rollback preserves group-write mode under a restrictive umask", async () => {
  const value = fixture();
  const current = server(
    "npx",
    ["-y", "@sweetsophia/noosphere-mcp@1.13.1"],
  );
  const codex = fakeCodex(value.configFile, current);
  chmodSync(value.configFile, 0o660);
  let gets = 0;
  const run: RunCodex = (args) => {
    if (args.join(" ") === "mcp get noosphere --json") {
      gets += 1;
      if (gets === 2) {
        return { code: 0, stdout: JSON.stringify(current), stderr: "" };
      }
    }
    return codex.run(args);
  };
  const previousUmask = process.umask(0o022);
  try {
    await assert.rejects(
      () => installCodexIntegration(installOptions(value, run)),
      /readback did not match/,
    );
  } finally {
    process.umask(previousUmask);
  }
  assert.equal(lstatSync(value.configFile).mode & 0o777, 0o660);
});

test("rollback does not replace an identical concurrent Codex config", async () => {
  const value = fixture();
  const current = server(
    "npx",
    ["-y", "@sweetsophia/noosphere-mcp@1.13.1"],
  );
  const codex = fakeCodex(value.configFile, current);
  const original = readFileSync(value.configFile, "utf8");
  const parked = `${value.configFile}.installer-copy`;
  let gets = 0;
  let replacementInode: bigint | undefined;
  const run: RunCodex = (args) => {
    if (args.join(" ") === "mcp get noosphere --json") {
      gets += 1;
      if (gets === 2) {
        renameSync(value.configFile, parked);
        writeFileSync(value.configFile, original, { encoding: "utf8", mode: 0o640 });
        replacementInode = lstatSync(value.configFile, { bigint: true }).ino;
      }
    }
    return codex.run(args);
  };

  await assert.rejects(
    () => installCodexIntegration(installOptions(value, run)),
    /readback did not match/,
  );
  assert.equal(lstatSync(value.configFile, { bigint: true }).ino, replacementInode);
  assert.equal(lstatSync(value.configFile).mode & 0o777, 0o640);
  assert.equal(readFileSync(value.configFile, "utf8"), original);
});

test("rollback refuses to replace a different concurrent Codex config", async () => {
  const value = fixture();
  const current = server(
    "npx",
    ["-y", "@sweetsophia/noosphere-mcp@1.13.1"],
  );
  const codex = fakeCodex(value.configFile, current);
  const parked = `${value.configFile}.installer-copy`;
  const sentinel = "# concurrent user-owned config\n";
  let gets = 0;
  let replacementInode: bigint | undefined;
  const run: RunCodex = (args) => {
    if (args.join(" ") === "mcp get noosphere --json") {
      gets += 1;
      if (gets === 2) {
        renameSync(value.configFile, parked);
        writeFileSync(value.configFile, sentinel, { encoding: "utf8", mode: 0o640 });
        replacementInode = lstatSync(value.configFile, { bigint: true }).ino;
      }
    }
    return codex.run(args);
  };

  await assert.rejects(
    () => installCodexIntegration(installOptions(value, run)),
    /Rollback also failed:.*identity or contents changed/,
  );
  assert.equal(lstatSync(value.configFile, { bigint: true }).ino, replacementInode);
  assert.equal(lstatSync(value.configFile).mode & 0o777, 0o640);
  assert.equal(readFileSync(value.configFile, "utf8"), sentinel);
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

test("rollback refuses to remove a concurrent user-owned MCP server", async () => {
  const value = fixture();
  const userOwned = server("user-launcher", ["--preserve"]);
  const sentinel = "# concurrent user-owned server config\n";
  let current: StoredServer | undefined;
  let removeCalled = false;
  const run: RunCodex = (args) => {
    if (args.join(" ") === "mcp get noosphere --json") {
      return current
        ? { code: 0, stdout: JSON.stringify(current), stderr: "" }
        : {
            code: 1,
            stdout: "",
            stderr: "Error: No MCP server named 'noosphere' found.",
          };
    }
    if (args[0] === "mcp" && args[1] === "add") {
      current = userOwned;
      writeFileSync(value.configFile, sentinel, "utf8");
      return { code: 1, stdout: "", stderr: "failure after concurrent replacement" };
    }
    if (args.join(" ") === "mcp remove noosphere") {
      removeCalled = true;
      current = undefined;
      return { code: 0, stdout: "Removed.", stderr: "" };
    }
    return { code: 2, stdout: "", stderr: `Unexpected args: ${args.join(" ")}` };
  };

  await assert.rejects(
    () => installCodexIntegration(installOptions(value, run)),
    /Rollback also failed:.*current launcher is not the installer-owned launcher/,
  );
  assert.equal(current, userOwned);
  assert.equal(removeCalled, false);
  assert.equal(readFileSync(value.configFile, "utf8"), sentinel);
});

test("refuses a symlink swap before Codex rollback touches external state", async () => {
  const value = fixture();
  const parkedHome = `${value.codexHome}.parked`;
  const externalHome = `${value.codexHome}.external`;
  mkdirSync(externalHome, { recursive: true });
  const externalConfig = join(externalHome, "config.toml");
  const sentinel = "# external sentinel\n";
  writeFileSync(externalConfig, sentinel, "utf8");

  const codex = fakeCodex(
    value.configFile,
    undefined,
    "after",
    readForwardedEnvVars,
    () => {
      renameSync(value.codexHome, parkedHome);
      symlinkSync(externalHome, value.codexHome, "dir");
    },
  );

  await assert.rejects(
    () => installCodexIntegration(installOptions(value, codex.run)),
    /Rollback also failed:.*Codex home.*real directory/,
  );
  assert.equal(readFileSync(externalConfig, "utf8"), sentinel);
  assert.equal(
    existsSync(join(value.home, ".agents", "skills", "noosphere-memory", "SKILL.md")),
    false,
  );
});

test("refuses a skill-directory swap before rollback unlinks external state", async () => {
  const value = fixture();
  const skillDirectory = join(value.home, ".agents", "skills", "noosphere-memory");
  const parkedDirectory = `${skillDirectory}.parked`;
  const externalDirectory = `${skillDirectory}.external`;
  const externalSkill = join(externalDirectory, "SKILL.md");
  const sourceSkill = readFileSync(value.source, "utf8");

  const codex = fakeCodex(
    value.configFile,
    undefined,
    "after",
    readForwardedEnvVars,
    () => {
      renameSync(skillDirectory, parkedDirectory);
      mkdirSync(externalDirectory, { recursive: true });
      writeFileSync(externalSkill, sourceSkill, "utf8");
      symlinkSync(externalDirectory, skillDirectory, "dir");
    },
  );

  let installError: unknown;
  try {
    await installCodexIntegration(installOptions(value, codex.run));
    assert.fail("Expected the installer to reject the skill-directory swap.");
  } catch (error) {
    installError = error;
  }
  assert.equal(existsSync(externalSkill), true);
  assert.equal(readFileSync(externalSkill, "utf8"), sourceSkill);
  assert.match(
    installError instanceof Error ? installError.message : String(installError),
    /Rollback also failed:.*Codex skill directory.*real directory/,
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

test("does not delete an identical-byte replacement during rollback", async () => {
  const value = fixture();
  const codex = fakeCodex(value.configFile);
  const skillFile = join(
    value.home,
    ".agents",
    "skills",
    "noosphere-memory",
    "SKILL.md",
  );
  const parkedSkill = `${skillFile}.installer-copy`;
  const replacement = readFileSync(value.source, "utf8");
  const run: RunCodex = (args) => {
    if (args[0] === "mcp" && args[1] === "add") {
      renameSync(skillFile, parkedSkill);
      writeFileSync(skillFile, replacement, "utf8");
      return { code: 1, stdout: "", stderr: "failure after same-byte skill replacement" };
    }
    return codex.run(args);
  };

  await assert.rejects(
    () => installCodexIntegration(installOptions(value, run)),
    /failure after same-byte skill replacement/,
  );
  assert.equal(existsSync(skillFile), true);
  assert.equal(readFileSync(skillFile, "utf8"), replacement);
  assert.equal(existsSync(parkedSkill), true);
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
