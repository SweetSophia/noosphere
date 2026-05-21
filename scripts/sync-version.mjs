#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const version = readFileSync(resolve(root, "VERSION"), "utf8").trim();

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`VERSION must be a semver-like value, got ${JSON.stringify(version)}`);
}

const ignoredDirs = new Set([".git", ".next", "coverage", "node_modules"]);
const packageJsonFiles = discoverPackageJsonFiles(root);
const packageDirs = packageJsonFiles.map((file) => dirname(file));

const changed = [];

function updateFile(relativePath, update) {
  const path = resolve(root, relativePath);
  const before = readFileSync(path, "utf8");
  const after = update(before);
  if (before !== after) {
    changed.push(relativePath);
    if (!checkOnly) {
      writeFileSync(path, after);
    }
  }
}

function updatePackageJson(text) {
  const data = JSON.parse(text);
  data.version = version;
  return `${JSON.stringify(data, null, 2)}\n`;
}

for (const file of packageJsonFiles) {
  updateFile(file, updatePackageJson);
}

if (!checkOnly) {
  for (const packageDir of packageDirs) {
    if (existsSync(resolve(root, packageDir, "package-lock.json"))) {
      execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], {
        cwd: resolve(root, packageDir),
        stdio: "inherit",
      });
    }
  }
}

for (const packageDir of packageDirs) {
  const lockPath = `${packageDir}/package-lock.json`;
  if (existsSync(resolve(root, lockPath))) {
    updateFile(lockPath, (text) => {
      const data = JSON.parse(text);
      const lockVersion = data.packages?.[""]?.version ?? data.version;
      if (lockVersion !== version) {
        throw new Error(`${lockPath} version ${lockVersion} does not match VERSION=${version}`);
      }
      return text;
    });
  }
}

updateFile("hermes-noosphere-memory/plugins/memory/noosphere/plugin.yaml", (text) =>
  text.replace(/^version:\s*.*$/m, `version: ${version}`),
);

updateFile("docker-compose.yml", (text) =>
  text.replace(/\$\{NOOSPHERE_VERSION:-[^}]+}/g, `\${NOOSPHERE_VERSION:-${version}}`),
);

if (changed.length > 0) {
  if (checkOnly) {
    console.error(`Version metadata is out of sync with VERSION=${version}:`);
    for (const file of changed) {
      console.error(`- ${file}`);
    }
    process.exit(1);
  }
  console.log(`Synchronized ${changed.length} file(s) to VERSION=${version}.`);
} else {
  console.log(`Version metadata already synchronized to VERSION=${version}.`);
}

function discoverPackageJsonFiles(directory, discovered = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        discoverPackageJsonFiles(resolve(directory, entry.name), discovered);
      }
      continue;
    }

    if (entry.isFile() && entry.name === "package.json") {
      discovered.push(relative(root, resolve(directory, entry.name)));
    }
  }

  return discovered.sort();
}
