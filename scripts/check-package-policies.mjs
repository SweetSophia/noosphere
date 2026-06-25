#!/usr/bin/env node

import { readFileSync } from "node:fs";
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
const npmPublishWorkflow = readText(policy.npmPublishWorkflow);
const npmPublishWorkflowLines = workflowLines(npmPublishWorkflow);

expect(
  injectedPackage.private === true,
  `${policy.helper.name} must stay private because it is an internal bundled helper, not an independently published npm package.`,
);
expect(
  !Object.hasOwn(injectedPackage, "publishConfig"),
  `${policy.helper.name} must not define publishConfig while the policy is bundled-only.`,
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
  "The npm publish workflow must not define a release tag prefix for the bundled-only helper.",
);
expect(
  !hasWorkflowInput(npmPublishWorkflowLines, "publish_injected") &&
    !hasForbiddenHelperPublishKey(npmPublishWorkflowLines, policy.forbiddenPublishSignals),
  "The npm publish workflow must not expose a publish_injected* dispatch input/job for the bundled-only helper.",
);

if (failures.length > 0) {
  console.error("Package policy check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Package policy check passed.");
