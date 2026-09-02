#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const policy = {
  helper: {
    name: "@sweetsophia/noosphere-injected-memory",
    dir: "noosphere-injected-memory",
    rootDependency: "file:./noosphere-injected-memory",
    openclawDependency: "file:../noosphere-injected-memory",
    rootLockLinkPath: "node_modules/@sweetsophia/noosphere-injected-memory",
    rootLockPackagePath: "noosphere-injected-memory",
    openclawLockLinkPath: "node_modules/@sweetsophia/noosphere-injected-memory",
    openclawLockPackagePath: "../noosphere-injected-memory",
    allowedRootResolved: new Set([
      "noosphere-injected-memory",
      "file:noosphere-injected-memory",
      "file:./noosphere-injected-memory",
    ]),
    allowedOpenclawResolved: new Set([
      "../noosphere-injected-memory",
      "file:../noosphere-injected-memory",
    ]),
  },
  openclaw: {
    dir: "openclaw-noosphere-memory",
    packageName: "@sweetsophia/openclaw-noosphere-memory",
  },
  npmPublishWorkflow: ".github/workflows/npm-publish.yml",
  dockerPublishWorkflow: ".github/workflows/docker-publish.yml",
  hermesReleaseWorkflow: ".github/workflows/hermes-release.yml",
  installerReleaseWorkflow: ".github/workflows/installer-release.yml",
  forbiddenPublishSignals: ["injectedmemory", "noosphereinjectedmemory"],
};

function readText(relativePath) {
  try {
    return readFileSync(resolve(root, relativePath), "utf8");
  } catch (error) {
    failures.push(`Failed to read ${relativePath}: ${error.message}`);
    return "";
  }
}

function readJson(relativePath) {
  try {
    return JSON.parse(readText(relativePath));
  } catch (error) {
    failures.push(`Failed to parse ${relativePath}: ${error.message}`);
    return {};
  }
}

function expect(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

function getLockPackage(lock, packagePath) {
  return lock.packages?.[packagePath];
}

function isLocalLockLink(entry, allowedResolvedValues) {
  return entry?.link === true && allowedResolvedValues.has(entry.resolved);
}

function bundledDependencyNames(pkg) {
  const bundled = [
    ...(Array.isArray(pkg.bundledDependencies) ? pkg.bundledDependencies : []),
    ...(Array.isArray(pkg.bundleDependencies) ? pkg.bundleDependencies : []),
  ];

  if (pkg.bundleDependencies === true || pkg.bundledDependencies === true) {
    bundled.push(...Object.keys(pkg.dependencies ?? {}));
  }

  return Array.from(new Set(bundled));
}

function workflowLines(workflowText) {
  return workflowText
    .split(/\r?\n/)
    .map(stripYamlComment)
    .map((line) => line.trim())
    .filter(Boolean);
}

function stripYamlComment(line) {
  let quote = null;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if ((char === '"' || char === "'") && line[index - 1] !== "\\") {
      quote = quote === char ? null : quote ?? char;
      continue;
    }

    if (char === "#" && quote === null) {
      return line.slice(0, index);
    }
  }

  return line;
}

function hasDockerRefTagEntry(lines) {
  return lines.some((line) => {
    const fields = new Map(
      line.split(",").map((field) => {
        const separator = field.indexOf("=");
        return separator === -1
          ? [field.trim(), ""]
          : [field.slice(0, separator).trim(), field.slice(separator + 1).trim()];
      }),
    );
    return fields.get("type") === "ref" && fields.get("event") === "tag";
  });
}

function unpinnedActionUses(lines) {
  return lines
    .map(yamlKeyValue)
    .filter((entry) => entry?.key === "uses")
    .map((entry) => entry.value)
    .filter((value) => !/@[0-9a-f]{40}$/.test(value));
}

function parseYamlScalar(value) {
  const trimmed = value.trim();
  const quote = trimmed[0];

  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function yamlKeyValue(line) {
  const match = line.match(/^(?:-\s*)?(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_-]*)):\s*(.*)$/);

  if (!match) {
    return null;
  }

  return {
    key: match[1] ?? match[2] ?? match[3],
    value: parseYamlScalar(match[4]),
  };
}

function yamlListValue(line) {
  const match = line.match(/^-\s+(.+)$/);

  if (!match || yamlKeyValue(line)) {
    return null;
  }

  return parseYamlScalar(match[1]);
}

function hasPathTrigger(lines, path) {
  return lines.some((line) => yamlListValue(line) === path);
}

function hasMatrixPackage(lines, packageDir, packageName) {
  for (let index = 0; index < lines.length; index += 1) {
    const entry = yamlKeyValue(lines[index]);

    if (entry?.key !== "dir" || entry.value !== packageDir) {
      continue;
    }

    for (let lookahead = index + 1; lookahead < lines.length; lookahead += 1) {
      if (lines[lookahead].startsWith("- ")) {
        break;
      }

      const nextEntry = yamlKeyValue(lines[lookahead]);

      if (nextEntry?.key === "name" && nextEntry.value === packageName) {
        return true;
      }
    }
  }

  return false;
}

function hasWorkflowInput(lines, inputName) {
  return lines.some((line) => {
    const entry = yamlKeyValue(line);

    return entry?.key === inputName;
  });
}

function indentation(line) {
  return line.match(/^ */)?.[0].length ?? 0;
}

function yamlNamedBlock(text, key, indent) {
  const lines = text.split(/\r?\n/);
  const indentationPrefix = " ".repeat(indent);
  const headers = [
    `${indentationPrefix}${key}:`,
    `${indentationPrefix}"${key}":`,
    `${indentationPrefix}'${key}':`,
  ];
  const start = lines.findIndex((line) =>
    headers.some((header) => line === header || line.startsWith(`${header} `)));
  if (start < 0) return "";
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (indentation(line) <= indent) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function yamlKeysAtIndent(text, indent) {
  const pattern = new RegExp(`^ {${indent}}([A-Za-z0-9_-]+):\\s*(?:#.*)?$`);
  return text
    .split(/\r?\n/)
    .map((line) => pattern.exec(line)?.[1])
    .filter((key) => key !== undefined);
}

function yamlStepBlock(jobBlock, name) {
  const lines = jobBlock.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  if (start < 0) return "";
  const indent = indentation(lines[start]);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (indentation(line) <= indent) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function exactBlockLines(block, expected) {
  const lines = workflowLines(block);
  return lines.length === expected.length && expected.every((line, index) => lines[index] === line);
}

function noticeSection(text, heading) {
  const normalized = text.replace(/\r\n/g, "\n");
  const divider = "=".repeat(80);
  const marker = `${divider}\n${heading}\n${divider}\n`;
  const start = normalized.indexOf(marker);
  if (start < 0) return "";
  const contentStart = start + marker.length;
  const end = normalized.indexOf(`\n${divider}\n`, contentStart);
  return (end < 0 ? normalized.slice(contentStart) : normalized.slice(contentStart, end)).trim();
}

function hasConsecutiveRawLines(block, expected) {
  const lines = block.split(/\r?\n/).map((line) => line.trim());
  return lines.some((_, start) =>
    expected.every((line, offset) => lines[start + offset] === line),
  );
}

function yamlScalarLine(block, name, indent) {
  const indentationPrefix = " ".repeat(indent);
  const prefixes = [
    `${indentationPrefix}${name}:`,
    `${indentationPrefix}"${name}":`,
    `${indentationPrefix}'${name}':`,
  ];
  return block.split("\n").find((line) =>
    prefixes.some((prefix) => line.startsWith(prefix)))?.trim() ?? "";
}

function hasExactNativeDockerMatrix(block) {
  return exactBlockLines(yamlNamedBlock(block, "include", 8), [
    "include:",
    "- platform: linux/amd64",
    "slug: amd64",
    "runner: ubuntu-latest",
    "- platform: linux/arm64",
    "slug: arm64",
    "runner: ubuntu-24.04-arm",
  ]);
}

function normalizeSignal(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hasForbiddenHelperPublishKey(lines, forbiddenSignals) {
  return lines.some((line) => {
    const entry = yamlKeyValue(line);

    if (!entry) {
      return false;
    }

    const key = normalizeSignal(entry.key);

    return key.startsWith("publish") && forbiddenSignals.some((signal) => key.includes(signal));
  });
}

function hasForbiddenHelperTag(lines, forbiddenSignals) {
  for (const line of lines) {
    const tagMatches = line.matchAll(/["'\s[]?(v-[A-Za-z0-9_*.-]+)/g);

    for (const match of tagMatches) {
      const tag = normalizeSignal(match[1]);

      if (forbiddenSignals.some((signal) => tag.includes(signal))) {
        return true;
      }
    }
  }

  return false;
}

const rootPackage = readJson("package.json");
const rootLock = readJson("package-lock.json");
const injectedPackage = readJson(`${policy.helper.dir}/package.json`);
const injectedLock = readJson(`${policy.helper.dir}/package-lock.json`);
const openclawPackage = readJson(`${policy.openclaw.dir}/package.json`);
const openclawLock = readJson(`${policy.openclaw.dir}/package-lock.json`);
const mcpPackage = readJson("noosphere-mcp/package.json");
const rootReadme = readText("README.md");
const rootLicense = readText("LICENSE");
const mcpLicense = readText("noosphere-mcp/LICENSE");
const rootNotice = readText("NOTICE");
const mcpNotice = readText("noosphere-mcp/NOTICE");
const npmPublishWorkflow = readText(policy.npmPublishWorkflow);
const npmPublishWorkflowLines = workflowLines(npmPublishWorkflow);
const npmPackageCheckJob = yamlNamedBlock(npmPublishWorkflow, "package-check", 2);
const npmPublishHelperJob = yamlNamedBlock(npmPublishWorkflow, "publish_helper", 2);
const npmPublishOpenclawJob = yamlNamedBlock(npmPublishWorkflow, "publish_openclaw", 2);
const npmPublishOpencodeJob = yamlNamedBlock(npmPublishWorkflow, "publish_opencode", 2);
const npmPublishKilocodeJob = yamlNamedBlock(npmPublishWorkflow, "publish_kilocode", 2);
const npmPublishMcpJob = yamlNamedBlock(npmPublishWorkflow, "publish_mcp", 2);
const npmJobsBlock = yamlNamedBlock(npmPublishWorkflow, "jobs", 0);
const npmPushTrigger = yamlNamedBlock(npmPublishWorkflow, "push", 2);
const npmJobNames = yamlKeysAtIndent(npmJobsBlock, 2);
const npmPackageCheckIf = yamlNamedBlock(npmPackageCheckJob, "if", 4);
const npmPackageCheckContinueOnError = yamlScalarLine(
  npmPackageCheckJob,
  "continue-on-error",
  4,
);
const npmAuditStep = yamlStepBlock(npmPackageCheckJob, "Audit package dependencies");
const npmPublishMcpCondition = yamlNamedBlock(npmPublishMcpJob, "if", 4);
const npmPublishMcpConcurrency = yamlNamedBlock(npmPublishMcpJob, "concurrency", 4);
const expectedNoticeAttribution = [
  "When redistributing this Work or a Derivative Work, preserve the applicable",
  "attribution notices as required by Section 4(d) of the Apache License 2.0.",
  "This NOTICE is informational and does not add license conditions.",
  "",
  "If your Derivative Work modifies this software, mark modified files as",
  "required by Section 4(b). The Apache License 2.0 does not grant trademark",
  "rights, so do not imply endorsement when using Noosphere marks.",
].join("\n");
const expectedNoticeSha256 = "4a04ec21f01d68561240285bc61a9080f0e4a07c5f12f55ddab0f77347ba5c6a";
const expectedNpmJobNames = [
  "package-check",
  "publish_helper",
  "publish_openclaw",
  "publish_opencode",
  "publish_kilocode",
  "publish_mcp",
];
const expectedNpmMatrixPackages = [
  ["noosphere-injected-memory", "@sweetsophia/noosphere-injected-memory"],
  ["openclaw-noosphere-memory", "@sweetsophia/openclaw-noosphere-memory"],
  ["opencode-noosphere-memory", "@sweetsophia/opencode-noosphere-memory"],
  ["kilocode-noosphere-memory", "@sweetsophia/kilocode-noosphere-memory"],
  ["noosphere-mcp", "@sweetsophia/noosphere-mcp"],
];
const npmPackageCheckLines = workflowLines(npmPackageCheckJob);
const npmMatrixDirectoryCount = npmPackageCheckLines.filter(
  (line) => yamlKeyValue(line)?.key === "dir",
).length;
const trackedDistCheck = "git diff --exit-code -- dist";
const untrackedDistCheck = 'test -z "$(git ls-files --others --exclude-standard -- dist)"';
const npmDistVerificationJobs = [
  npmPackageCheckJob,
  npmPublishOpenclawJob,
  npmPublishOpencodeJob,
  npmPublishKilocodeJob,
  npmPublishMcpJob,
];
const dockerPublishWorkflow = readText(policy.dockerPublishWorkflow);
const dockerPublishWorkflowLines = workflowLines(dockerPublishWorkflow);
const dockerPushTrigger = yamlNamedBlock(dockerPublishWorkflow, "push", 2);
const dockerPullRequestTrigger = yamlNamedBlock(dockerPublishWorkflow, "pull_request", 2);
const dockerGlobalPermissions = yamlNamedBlock(dockerPublishWorkflow, "permissions", 0);
const dockerValidationJob = yamlNamedBlock(dockerPublishWorkflow, "validate", 2);
const dockerPrPlatformJob = yamlNamedBlock(dockerPublishWorkflow, "docker-platform", 2);
const dockerPublishPlatformJob = yamlNamedBlock(dockerPublishWorkflow, "publish-platform", 2);
const dockerPublishIndexJob = yamlNamedBlock(dockerPublishWorkflow, "publish-index", 2);
const dockerFinalJob = yamlNamedBlock(dockerPublishWorkflow, "docker", 2);
const dockerPrBuildStep = yamlStepBlock(dockerPrPlatformJob, "Build target platform for validation");
const dockerPublishBuildStep = yamlStepBlock(dockerPublishPlatformJob, "Build and push target platform by digest");
const dockerAssembleStep = yamlStepBlock(dockerPublishIndexJob, "Assemble and verify multi-platform image");
const dockerFinalStep = yamlStepBlock(dockerFinalJob, "Require every applicable Docker gate");
const pluginTagExclusions = ["v-openclaw-", "v-opencode-", "v-kilocode-", "v-hermes-", "v-mcp-"]
  .map((tag) => `!startsWith(github.ref, 'refs/tags/${tag}')`)
  .join(" && ");
const dockerValidateCondition = `if: "${pluginTagExclusions}"`;
const dockerPublishCondition = `if: \${{ github.ref_type == 'tag' && ${pluginTagExclusions} }}`;
const dockerFinalCondition = `if: \${{ always() && ${pluginTagExclusions} }}`;
const dockerTriggerPaths = [
  '- ".github/workflows/docker-publish.yml"',
  '- "Dockerfile"',
  '- "next.config.ts"',
  '- "src/**"',
  '- "prisma/**"',
  '- "prisma.config.ts"',
  '- "public/**"',
  '- "scripts/**"',
  '- "package.json"',
  '- "package-lock.json"',
  '- "VERSION"',
  '- "docker-compose.yml"',
  '- "docker/**"',
  '- "!docker/postgres-pgvector/**"',
  '- "noosphere-injected-memory/**"',
  '- "openclaw-noosphere-memory/**"',
];
const dockerCheckoutCount = dockerPublishWorkflowLines.filter((line) => line.startsWith("uses: actions/checkout@")).length;
const dockerCheckoutCredentialGuards = dockerPublishWorkflowLines.filter((line) => line === "persist-credentials: false").length;
const hermesReleaseWorkflow = readText(policy.hermesReleaseWorkflow);
const hermesReleaseWorkflowLines = workflowLines(hermesReleaseWorkflow);
const installerReleaseWorkflow = readText(policy.installerReleaseWorkflow);
const installerReleaseWorkflowLines = workflowLines(installerReleaseWorkflow);
const ciWorkflow = readText(".github/workflows/ci.yml");
const ciWorkflowLines = workflowLines(ciWorkflow);
const installer = readText("install.sh");
const installerBackend = readText("install-openclaw.sh");
const installerPackager = readText("scripts/package-installer.sh");
const installerBackendTest = readText("scripts/test-installer-backend-mode.sh");
const installerUxTest = readText("scripts/test-installer-ux.sh");
const installerPackageTest = readText("scripts/test-installer-package.sh");
const postgresImagePolicy = readText("scripts/check-postgres-image-policy.mjs");
const versionSyncScript = readText("scripts/sync-version.mjs");
const releaseVersion = readText("VERSION").trim();
const coordinatedReleaseGuide = readText("docs/COORDINATED-RELEASE.md");
const composeFile = readText("docker-compose.yml");
const environmentExample = readText("noosphere.env.example");
const guidedCommandDocs = [
  "docs/OPENCLAW-OFFICIAL-PLUGIN-SETUP.md",
  "docs/OPENCLAW-OFFICIAL-PLUGIN-DEVELOPMENT-PLAN.md",
  "docs/POSTGRES-PGVECTOR-COMPOSE-UPGRADE.md",
  "docs/articles/noosphere-medium-article.md",
  "openclaw-noosphere-memory/README.md",
  "opencode-noosphere-memory/README.md",
  "kilocode-noosphere-memory/README.md",
].map((relativePath) => ({ relativePath, text: readText(relativePath) }));
const workflowPolicyPaths = [
  ".github/workflows/ci.yml",
  ".github/workflows/installer-release.yml",
  ".github/workflows/postgres-pgvector-image.yml",
  ".github/workflows/npm-publish.yml",
  ".github/workflows/hermes-release.yml",
  ".github/workflows/docker-publish.yml",
  ".github/workflows/hybrid-storage.yml",
  ".github/workflows/postgres-pgvector-rehearsal.yml",
  ".github/workflows/autoreview.yml",
];
for (const relativePath of workflowPolicyPaths) {
  const workflow = readText(relativePath);
  const lines = workflowLines(workflow);
  expect(
    unpinnedActionUses(lines).length === 0,
    `${relativePath} must pin every third-party Action to a full commit SHA.`,
  );
  const normalizedWorkflow = lines.join("\n");
  expect(
    (normalizedWorkflow.match(/actions\/checkout@/g)?.length ?? 0) ===
      (normalizedWorkflow.match(/persist-credentials: false/g)?.length ?? 0),
    `${relativePath} must disable persisted checkout credentials for every checkout step.`,
  );
}

expect(
  mcpPackage.license === "Apache-2.0",
  "The Noosphere MCP package must inherit the repository Apache-2.0 license identifier.",
);
expect(
  Array.isArray(mcpPackage.files) && mcpPackage.files.includes("LICENSE"),
  "The Noosphere MCP package tarball must include its LICENSE file.",
);
expect(
  mcpLicense === rootLicense,
  "The Noosphere MCP package LICENSE must match the repository LICENSE byte-for-byte.",
);
expect(
  Array.isArray(mcpPackage.files) && mcpPackage.files.includes("NOTICE"),
  "The Noosphere MCP package tarball must include its NOTICE file.",
);
expect(
  mcpNotice === rootNotice,
  "The Noosphere MCP package NOTICE must match the repository NOTICE byte-for-byte.",
);
expect(
  noticeSection(rootNotice, "ATTRIBUTION") === expectedNoticeAttribution,
  "The repository NOTICE must describe Apache attribution without adding UI-credit conditions.",
);
expect(
  createHash("sha256").update(rootNotice).digest("hex") === expectedNoticeSha256,
  "The repository NOTICE must match the canonical Apache-compatible text exactly.",
);
expect(
  rootReadme.includes("the five integrations") &&
    /does\s+not add a UI-credit or hosted-service condition/.test(rootReadme) &&
    !rootReadme.includes("the four plugins") &&
    !rootReadme.includes('"Powered by Noosphere" link'),
  "The root README must describe all five integrations without reviving a UI-attribution condition.",
);
expect(
  JSON.stringify(npmJobNames) === JSON.stringify(expectedNpmJobNames),
  "The npm publish workflow must contain exactly the approved job set.",
);
expect(
  npmPackageCheckIf.trim() === "",
  "The package-check job must not have a job-level execution guard.",
);
expect(
  npmPackageCheckContinueOnError === "",
  "The package-check job must not soften failures with continue-on-error.",
);
expect(
  npmMatrixDirectoryCount === expectedNpmMatrixPackages.length &&
    expectedNpmMatrixPackages.every(([directory, name]) =>
      hasMatrixPackage(npmPackageCheckLines, directory, name)),
  "The package-check matrix must contain exactly the five approved publishable packages.",
);
expect(
  exactBlockLines(npmPushTrigger, [
    "push:",
    'tags: ["v-openclaw-*", "v-opencode-*", "v-kilocode-*", "v-mcp-*"]',
  ]),
  "The npm publish workflow must retain every approved release-tag trigger, including v-mcp-*.",
);
expect(
  npmPublishWorkflowLines.filter((line) => line === trackedDistCheck).length === 6 &&
    npmPublishWorkflowLines.filter((line) => line === untrackedDistCheck).length === 6,
  "Every committed-dist gate must reject both tracked differences and untracked generated files.",
);
expect(
  npmDistVerificationJobs.every((job) =>
    exactBlockLines(yamlStepBlock(job, "Verify committed dist is current"), [
      "- name: Verify committed dist is current",
      "run: |",
      trackedDistCheck,
      untrackedDistCheck,
    ])),
  "Each package-check and direct publish job must own its exact tracked-and-untracked dist gate.",
);
expect(
  hasConsecutiveRawLines(npmPublishHelperJob, [
    "npm run build",
    trackedDistCheck,
    untrackedDistCheck,
    'npm pack --json > "$RUNNER_TEMP/injected-pack.json"',
  ]),
  "The bundled-helper publish job must verify tracked and untracked dist immediately before packing.",
);
expect(
  exactBlockLines(npmAuditStep, [
    "- name: Audit package dependencies",
    "run: npm audit --audit-level=low",
  ]),
  "Every package-check matrix entry must run the dependency audit.",
);
expect(
  exactBlockLines(npmPublishMcpCondition, [
    "if: |",
    "startsWith(github.ref, 'refs/tags/v-mcp-') ||",
    "(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/master' && inputs.publish_mcp)",
  ]) &&
    exactBlockLines(npmPublishMcpConcurrency, [
      "concurrency:",
      "group: npm-publish-noosphere-mcp",
      "cancel-in-progress: false",
    ]),
  "Manual MCP publication must be master-only and MCP releases must be serialized without cancellation.",
);

expect(
  injectedPackage.private !== true,
  `${policy.helper.name} must be publishable as a coordinated npm artifact.`,
);
expect(
  injectedPackage.publishConfig?.access === "public",
  `${policy.helper.name} must declare public npm access.`,
);
expect(
  rootPackage.dependencies?.[policy.helper.name] === policy.helper.rootDependency,
  `The app must consume ${policy.helper.name} through the local file dependency.`,
);
expect(
  isLocalLockLink(
    getLockPackage(rootLock, policy.helper.rootLockLinkPath),
    policy.helper.allowedRootResolved,
  ),
  `The root lockfile must resolve ${policy.helper.name} from the local helper directory.`,
);
expect(
  getLockPackage(rootLock, policy.helper.rootLockPackagePath)?.name === policy.helper.name,
  `The root lockfile must include the local ${policy.helper.name} package entry.`,
);
expect(
  getLockPackage(injectedLock, "")?.name === policy.helper.name,
  `${policy.helper.name}/package-lock.json must describe the helper package.`,
);
expect(
  openclawPackage.dependencies?.[policy.helper.name] === policy.helper.openclawDependency,
  `The OpenClaw plugin must depend on the local ${policy.helper.name} helper.`,
);
expect(
  bundledDependencyNames(openclawPackage).includes(policy.helper.name),
  `The OpenClaw plugin must bundle ${policy.helper.name} so npm consumers do not need a separate helper package.`,
);
expect(
  isLocalLockLink(
    getLockPackage(openclawLock, policy.helper.openclawLockLinkPath),
    policy.helper.allowedOpenclawResolved,
  ),
  `The OpenClaw lockfile must resolve ${policy.helper.name} from the local helper directory.`,
);
expect(
  getLockPackage(openclawLock, policy.helper.openclawLockPackagePath)?.name === policy.helper.name,
  `The OpenClaw lockfile must include the local ${policy.helper.name} helper package entry.`,
);
expect(
  hasPathTrigger(npmPublishWorkflowLines, `${policy.helper.dir}/**`),
  "The npm publish workflow must keep checking helper package source changes.",
);
expect(
  hasMatrixPackage(npmPublishWorkflowLines, policy.helper.dir, policy.helper.name),
  "The npm publish workflow package-check matrix must keep building the helper package from the helper directory.",
);
expect(
  !hasForbiddenHelperTag(npmPublishWorkflowLines, policy.forbiddenPublishSignals),
  "The bundled helper must publish through v-openclaw-$VERSION rather than a sixth release tag.",
);
expect(
  !hasWorkflowInput(npmPublishWorkflowLines, "publish_injected") &&
    npmPublishWorkflow.includes("  publish_helper:") &&
    npmPublishWorkflow.indexOf("\n  publish_helper:\n") <
      npmPublishWorkflow.indexOf("\n  publish_openclaw:\n") &&
    npmPublishWorkflow.includes("needs: [package-check, publish_helper]") &&
    npmPublishWorkflow.includes("npm pack --json") &&
    npmPublishWorkflow.includes("dist.integrity") &&
    npmPublishWorkflow.includes('npm publish "$TARBALL" --access public --provenance'),
  "The v-openclaw publication must publish or exact-integrity-verify the helper before OpenClaw without adding an independent dispatch input.",
);
expect(
  unpinnedActionUses(npmPublishWorkflowLines).length === 0,
  `The authenticated npm publisher must pin every action to a full commit SHA; unpinned: ${unpinnedActionUses(npmPublishWorkflowLines).join(", ")}`,
);
expect(
  versionSyncScript.includes("VERSION build metadata is unsupported because coordinated Docker tags cannot preserve it"),
  "The coordinated version policy must reject build metadata that cannot round-trip through Docker tags.",
);
expect(
  environmentExample.includes(`NOOSPHERE_VERSION=${rootPackage.version}`) &&
    !environmentExample.includes("NOOSPHERE_VERSION=latest"),
  "The public environment example must pin the coordinated release version rather than latest.",
);
expect(
  composeFile.includes('${OBSIDIAN_SYNC_HOST_VAULT_PATH:-./obsidian-vault}:/app/obsidian-vault:rw') &&
    !/(?:\/home\/|\/Users\/)[^$\s/]+\//.test(composeFile) &&
    !/APP_URL:-http:\/\/(?!127\.0\.0\.1|localhost)/.test(composeFile),
  "The release Compose file must use a configurable Obsidian host path and must not contain personal home paths or non-loopback URL defaults.",
);
for (const { relativePath, text } of guidedCommandDocs) {
  expect(
    text.includes(`releases/tag/v${releaseVersion}`) &&
      text.includes("all six installer assets") &&
      text.includes("sha256sum -c -") &&
      !text.includes(`NOOSPHERE_IMAGE="\${NOOSPHERE_IMAGE:-ghcr.io/sweetsophia/noosphere:${releaseVersion}}"`),
    `${relativePath} must gate pinned commands on the coordinated release and preserve persisted custom images.`,
  );
}
expect(
  dockerPublishWorkflowLines.includes("type=semver,pattern={{version}}") &&
    dockerPublishWorkflowLines.includes("type=sha,prefix=sha-") &&
    !hasDockerRefTagEntry(dockerPublishWorkflowLines),
  "The Docker publish workflow must strip the release tag's v prefix so NOOSPHERE_VERSION resolves to a published image tag.",
);
expect(
  dockerPublishWorkflow.includes('GITHUB_REF_NAME" != "v${version}"') &&
    workflowLines(dockerValidationJob).includes("runs-on: ubuntu-latest") &&
    exactBlockLines(yamlNamedBlock(dockerValidationJob, "outputs", 4), [
      "outputs:",
      "version: ${{ steps.version.outputs.version }}",
    ]) &&
    workflowLines(yamlStepBlock(dockerValidationJob, "Validate version metadata")).includes("id: version") &&
    exactBlockLines(yamlNamedBlock(dockerValidationJob, "permissions", 4), ["permissions:", "contents: read"]) &&
    yamlScalarLine(dockerValidationJob, "if", 4) === dockerValidateCondition &&
    exactBlockLines(dockerPushTrigger, [
      "push:",
      "branches: [main, master]",
      'tags: ["v*"]',
      "paths:",
      ...dockerTriggerPaths,
    ]) &&
    exactBlockLines(dockerPullRequestTrigger, [
      "pull_request:",
      "branches: [main, master]",
      "paths:",
      ...dockerTriggerPaths,
    ]),
  "The Docker workflow and its owning policy must trigger their own native-platform gates.",
);
expect(
  yamlScalarLine(dockerPrPlatformJob, "if", 4) === "if: github.ref_type != 'tag'" &&
    workflowLines(dockerPrPlatformJob).includes("needs: validate") &&
    workflowLines(dockerPrPlatformJob).includes("runs-on: ${{ matrix.runner }}") &&
    exactBlockLines(yamlNamedBlock(dockerPrPlatformJob, "permissions", 4), ["permissions:", "contents: read"]) &&
    hasExactNativeDockerMatrix(dockerPrPlatformJob) &&
    workflowLines(dockerPrBuildStep).includes("platforms: ${{ matrix.platform }}") &&
    workflowLines(dockerPrBuildStep).includes("load: true") &&
    workflowLines(dockerPrBuildStep).includes("push: false") &&
    yamlStepBlock(dockerPrPlatformJob, "Verify local image architecture") !== "" &&
    yamlStepBlock(dockerPrPlatformJob, "Log in to GitHub Container Registry") === "",
  "Pull-request Docker builds must run natively on both platforms, load and inspect each image, and receive no package-write authority.",
);
expect(
  yamlScalarLine(dockerPublishPlatformJob, "if", 4) === dockerPublishCondition &&
    workflowLines(dockerPublishPlatformJob).includes("needs: validate") &&
    workflowLines(dockerPublishPlatformJob).includes("runs-on: ${{ matrix.runner }}") &&
    exactBlockLines(yamlNamedBlock(dockerPublishPlatformJob, "permissions", 4), [
      "permissions:",
      "contents: read",
      "packages: write",
    ]) &&
    hasExactNativeDockerMatrix(dockerPublishPlatformJob) &&
    workflowLines(dockerPublishBuildStep).includes("platforms: ${{ matrix.platform }}") &&
    dockerPublishBuildStep.includes("push-by-digest=true") &&
    yamlStepBlock(dockerPublishPlatformJob, "Log in to GitHub Container Registry") !== "" &&
    yamlStepBlock(dockerPublishPlatformJob, "Upload platform digest") !== "",
  "Tag-only Docker jobs must build both platforms natively and publish each image only by digest.",
);
expect(
  yamlScalarLine(dockerPublishIndexJob, "if", 4) === dockerPublishCondition &&
    workflowLines(dockerPublishIndexJob).includes("needs: [validate, publish-platform]") &&
    exactBlockLines(yamlNamedBlock(dockerPublishIndexJob, "permissions", 4), [
      "permissions:",
      "contents: read",
      "packages: write",
    ]) &&
    !workflowLines(dockerAssembleStep).some((line) => line.startsWith("if:")) &&
    hasConsecutiveRawLines(dockerAssembleStep, [
      'if [[ ${#sources[@]} -ne 2 ]]; then',
      "printf 'expected two platform digests, found %s\\n' \"${#sources[@]}\" >&2",
      "exit 1",
      "fi",
    ]) &&
    dockerAssembleStep.includes("docker buildx imagetools create") &&
    dockerAssembleStep.includes('tag_args+=(-t "$tag")') &&
    dockerAssembleStep.includes("jq -r '.tags[]'") &&
    !dockerAssembleStep.includes("$(jq -cr") &&
    dockerAssembleStep.includes('sort == ["linux/amd64", "linux/arm64"]') &&
    yamlStepBlock(dockerPublishIndexJob, "Extract metadata").includes("flavor: latest=auto"),
  "The tag-only Docker index job must require both digest builds, assemble exactly two sources, and verify AMD64 plus ARM64 before success.",
);
expect(
  workflowLines(dockerFinalJob).includes("name: docker") &&
    workflowLines(dockerFinalJob).includes(
      "needs: [validate, docker-platform, publish-platform, publish-index]",
    ) &&
    yamlScalarLine(dockerFinalJob, "if", 4) === dockerFinalCondition &&
    exactBlockLines(yamlNamedBlock(dockerFinalJob, "permissions", 4), ["permissions:", "contents: read"]) &&
    exactBlockLines(dockerFinalStep, [
      "- name: Require every applicable Docker gate",
      "run: |",
      "test '${{ needs.validate.result }}' = success",
      'if [[ "$GITHUB_REF_TYPE" == tag ]]; then',
      "test '${{ needs['docker-platform'].result }}' = skipped",
      "test '${{ needs['publish-platform'].result }}' = success",
      "test '${{ needs['publish-index'].result }}' = success",
      "else",
      "test '${{ needs['docker-platform'].result }}' = success",
      "test '${{ needs['publish-platform'].result }}' = skipped",
      "test '${{ needs['publish-index'].result }}' = skipped",
      "fi",
    ]),
  "The final docker check must aggregate validation, PR builds, tag digest builds, and index publication without bypassing a skipped or failed dependency.",
);
expect(
  exactBlockLines(dockerGlobalPermissions, ["permissions:", "contents: read"]) &&
    dockerCheckoutCount > 0 &&
    dockerCheckoutCredentialGuards === dockerCheckoutCount &&
    !dockerPublishWorkflow.includes("docker/setup-qemu-action@") &&
    !dockerPublishWorkflow.includes("enable={{is_default_branch}}"),
  "The Docker workflow must keep global permissions read-only, disable checkout credentials, and never reintroduce emulated Node builds or default-branch latest publication.",
);
expect(
  unpinnedActionUses(dockerPublishWorkflowLines).length === 0,
  `The authenticated Docker publisher must pin every action to a full commit SHA; unpinned: ${unpinnedActionUses(dockerPublishWorkflowLines).join(", ")}`,
);
expect(
  hermesReleaseWorkflowLines.includes("contents: read") &&
    hermesReleaseWorkflowLines.includes("persist-credentials: false") &&
    hermesReleaseWorkflow.includes("actions/upload-artifact@") &&
    hermesReleaseWorkflow.includes("Verify release bundle installation") &&
    hermesReleaseWorkflow.includes(
      '(cd dist && sha256sum --check "hermes-noosphere-memory-${version}.tar.gz.sha256")',
    ) &&
    !hermesReleaseWorkflow.includes('sha256sum --check "${archive}.sha256"') &&
    !hermesReleaseWorkflow.includes("GH_TOKEN") &&
    !hermesReleaseWorkflow.includes("gh release upload"),
  "The Hermes tag workflow must verify checksums from dist, remain secret-free, install-test its bundle, and publish only a read-only Actions artifact.",
);
expect(
  installerReleaseWorkflowLines.includes("contents: read") &&
    installerReleaseWorkflowLines.includes("persist-credentials: false") &&
    installerReleaseWorkflow.includes("npm run installer:check") &&
    installerReleaseWorkflow.includes("scripts/package-installer.sh dist") &&
    installerReleaseWorkflow.includes("actions/upload-artifact@") &&
    installerReleaseWorkflow.includes("dist/install.sh.sha256") &&
    installerReleaseWorkflow.includes("dist/install-openclaw.sh.sha256") &&
    installerReleaseWorkflow.includes("docs/COORDINATED-RELEASE.md") &&
    installerReleaseWorkflow.includes("all six files to a draft release") &&
    unpinnedActionUses(installerReleaseWorkflowLines).length === 0 &&
    !installerReleaseWorkflow.includes("GH_TOKEN") &&
    !installerReleaseWorkflow.includes("gh release upload"),
  "The application tag must build and test checksum-owned installer assets using only pinned, read-only Actions steps.",
);
expect(
  ciWorkflow.includes("installer:\n    runs-on: ubuntu-latest") &&
    ciWorkflow.includes("actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10") &&
    ciWorkflow.includes("persist-credentials: false") &&
    ciWorkflow.includes("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020") &&
    unpinnedActionUses(ciWorkflowLines).length === 0 &&
    (ciWorkflow.match(/actions\/checkout@/g)?.length ?? 0) ===
      (ciWorkflow.match(/persist-credentials: false/g)?.length ?? 0) &&
    ciWorkflow.includes("npm run installer:check"),
  "Every hosted CI job must use immutable Actions, disable checkout credential persistence, and retain the installer gate.",
);
expect(
  coordinatedReleaseGuide.includes("application and five integration surfaces") &&
    coordinatedReleaseGuide.includes("`v-mcp-X.Y.Z` — `@sweetsophia/noosphere-mcp`") &&
    coordinatedReleaseGuide.includes("all six proposed tags") &&
    coordinatedReleaseGuide.includes("Create the five annotated integration tags") &&
    coordinatedReleaseGuide.includes("Opencode, Kilo Code, and MCP") &&
    coordinatedReleaseGuide.includes("all six tag object targets"),
  "The coordinated release guide must include the MCP tag in publication and public readback.",
);
expect(
  coordinatedReleaseGuide.includes("attach the complete\n   six-file installer artifact") &&
    coordinatedReleaseGuide.includes("install.sh` and `install.sh.sha256") &&
    coordinatedReleaseGuide.includes("install-openclaw.sh` and `install-openclaw.sh.sha256") &&
    coordinatedReleaseGuide.includes("--verify-release-files") &&
    coordinatedReleaseGuide.includes("Download all six assets again from the **public** release") &&
    coordinatedReleaseGuide.includes("--verify-release-files --verify-release-assets") &&
    postgresImagePolicy.includes('const verifyReleaseFiles = process.argv.includes("--verify-release-files")') &&
    postgresImagePolicy.includes('resolve(root, "scripts/package-installer.sh")') &&
    postgresImagePolicy.includes('mkdtempSync(join(tmpdir(), "noosphere-release-assets-"))') &&
    !postgresImagePolicy.includes("verifyReleaseArtifacts ||") &&
    coordinatedReleaseGuide.includes("Never move, overwrite, or force-push a published release tag or replace a\n   published release asset"),
  "The coordinated release guide must attach/read back all checksum-owned installer assets before publication.",
);
expect(
  installer.includes("BACKEND_URL='https://raw.githubusercontent.com/SweetSophia/noosphere/9195733bd59756d21d51d6d3b34e33ca3c8c674b/install-openclaw.sh'") &&
    installer.includes("BACKEND_SHA256='91784b96fb6a699555f35cb87cf5d5800644a2a1761956d537d9e7c32bafa973'") &&
    installer.includes("HERMES_BUNDLE_URL='https://github.com/SweetSophia/noosphere/releases/download/v1.13.1/hermes-noosphere-memory-1.13.1.tar.gz'") &&
    installer.includes("HERMES_BUNDLE_SHA256='5231c755ef7f6feaebcedae6aa412f19c43658814d83b0643acf5dc9887f9aae'") &&
    installer.includes("Refusing Noosphere backend with an unexpected checksum") &&
    installer.includes("Refusing Hermes bundle with an unexpected checksum") &&
    installer.includes("--core-only") &&
    installer.includes("--non-interactive") &&
    installer.includes("--dry-run") &&
    !installer.includes("/master/") &&
    !installer.includes("/main/"),
  "The general installer must support guided/core/automation modes and fetch only checksum-owned versioned release assets.",
);
expect(
  installerBackend.includes('NOOSPHERE_INSTALL_OPENCLAW="${NOOSPHERE_INSTALL_OPENCLAW:-true}"') &&
    installerBackend.includes('if [[ "$NOOSPHERE_INSTALL_OPENCLAW" == true ]]; then\n  need openclaw\nfi') &&
    installerBackend.includes('write_credentials_json "$NOOSPHERE_CREDENTIALS_FILE"') &&
    installerBackend.includes('assert_no_symlink_path_components "$target" credential') &&
    installerBackend.includes('Credentials were not printed. Read the mode-0600 file above when needed.') &&
    installerBackend.includes("run_openclaw()") &&
    installerBackend.includes("-u POSTGRES_PASSWORD") &&
    installerBackend.includes("-u NOOSPHERE_BOOTSTRAP_API_KEY") &&
    installerBackend.includes("-u NOOSPHERE_HYBRID_PROVIDER_CONFIG_JSON") &&
    installerBackend.includes("-u NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_JSON") &&
    installerBackend.includes("api_write_probe_status_with_key()") &&
    installerBackend.includes("validated_local_app_url()") &&
    installerBackend.includes("create_scoped_integration_key()") &&
    installerBackend.includes("select_scoped_integration_key") &&
    installerBackend.includes("write_credentials_json \"$SECRETS_FILE\" true false") &&
    installerBackend.includes('"permissions":"WRITE"') &&
    installerBackendTest.includes("scoped_keys=yes") &&
    installerBackendTest.includes("read_key_rejected=yes") &&
    installerBackendTest.includes("transport_rotation=blocked") &&
    installerBackendTest.includes("local_bootstrap_destination=yes") &&
    installerBackend.includes("curl --disable --noproxy '*' --connect-timeout 5 --max-time 15 \"$@\"") &&
    installerBackendTest.includes("proxy_bypass=yes") &&
    installerBackendTest.includes("backend proxy-bypass sabotage unexpectedly passed") &&
    installerBackendTest.includes("secret_argv=clean") &&
    installerBackendTest.includes("child_env=clean") &&
    installerBackendTest.includes("credential_parent_symlink=blocked") &&
    installerBackendTest.includes("symlinked credential parent unexpectedly passed") &&
    installerBackendTest.includes("OpenClaw child inherited secret variable") &&
    !installerBackend.includes("API KEY (save this - it will not be shown again)"),
  "The reviewed backend must preserve OpenClaw-by-default compatibility while supporting core-only mode and non-disclosing credentials.",
);
expect(
  installerPackager.includes("INSTALLER_BACKEND_URL=") &&
    installerPackager.includes("INSTALLER_HERMES_URL=") &&
    installerPackager.includes("INSTALLER_BACKEND_SHA256=") &&
    installerPackager.includes("INSTALLER_HERMES_SHA256=") &&
    installerPackager.includes("sha256sum install.sh > install.sh.sha256") &&
    installerPackager.includes("sha256sum install-openclaw.sh > install-openclaw.sh.sha256") &&
    installerUxTest.includes("secret_output=clean") &&
    installerUxTest.includes("lifecycle_modes=5") &&
    installerUxTest.includes('node_bin_dir=$(dirname "$(command -v node)")') &&
    installerUxTest.includes("no_tty_guard=yes") &&
    installerUxTest.includes("stale_overlay=clean") &&
    installerUxTest.includes("unversioned_dedupe=yes") &&
    installer.includes("Refusing symlinked Hermes home") &&
    installer.includes("Refusing symlinked Hermes path component") &&
    installer.includes('assert_no_symlink_path_components "$config_file" "integration config"') &&
    installerUxTest.includes("hermes_symlink=blocked") &&
    installerUxTest.includes("hermes_home_symlink=blocked") &&
    installerUxTest.includes("hermes_parent_symlink=blocked") &&
    installerUxTest.includes("integration_parent_symlink=blocked") &&
    installerUxTest.includes("symlinked integration config parent unexpectedly passed") &&
    installerUxTest.includes("randomized_credentials=yes") &&
    !installerUxTest.includes("fixture-admin-password") &&
    installerUxTest.includes("atomic_secret_rewrite=yes") &&
    installerUxTest.includes("scoped_tool_keys=yes") &&
    installerUxTest.includes("write_key_verified=yes") &&
    installerUxTest.includes("transport_rotation=blocked") &&
    installerUxTest.includes("local_bootstrap_destination=yes") &&
    installerUxTest.includes("port_binding=blocked") &&
    installerUxTest.includes("custom_port=preserved") &&
    installerUxTest.includes("custom_image=preserved") &&
    installer.includes("curl --disable --noproxy '*' --connect-timeout 5 --max-time 15 \"$@\"") &&
    installerUxTest.includes("proxy_bypass=yes") &&
    installerUxTest.includes("launcher proxy-bypass sabotage unexpectedly passed") &&
    installerUxTest.includes("child_env=clean") &&
    installerUxTest.includes("bootstrap_tool_config=absent") &&
    installerUxTest.includes("secret_argv=clean") &&
    installerPackageTest.includes("tampered backend unexpectedly passed") &&
    installerPackageTest.includes("tampered sibling backend unexpectedly passed") &&
    installerPackageTest.includes("sibling_checksum_sensitive=yes") &&
    installerPackageTest.includes("piped_entrypoint=yes") &&
    installerPackageTest.includes("release_set_verified=yes") &&
    installerPackageTest.includes("release_public_fixture_verified=yes") &&
    installerPackageTest.includes("release_negative_controls=7") &&
    installerPackageTest.includes("aligned tampered backend unexpectedly passed") &&
    installerPackageTest.includes("redirected launcher unexpectedly passed") &&
    installerPackageTest.includes("aligned tampered Hermes bundle unexpectedly passed") &&
    installerPackageTest.includes("missing release asset unexpectedly passed") &&
    installerPackageTest.includes("extra release asset unexpectedly passed") &&
    installerPackageTest.includes("malformed release checksum unexpectedly passed") &&
    installerPackageTest.includes("--verify-release-files") &&
    installerPackageTest.includes("deterministic=yes"),
  "Installer packaging and tests must own deterministic bytes, checksums, credential non-disclosure, and a tampered-backend negative control.",
);

if (failures.length > 0) {
  console.error("Package policy check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Package policy check passed.");
