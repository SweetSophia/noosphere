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
const dockerPublishWorkflow = readText(policy.dockerPublishWorkflow);
const dockerPublishWorkflowLines = workflowLines(dockerPublishWorkflow);
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
const coordinatedReleaseGuide = readText("docs/COORDINATED-RELEASE.md");
const composeFile = readText("docker-compose.yml");
const environmentExample = readText("noosphere.env.example");
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
expect(
  dockerPublishWorkflowLines.includes("type=semver,pattern={{version}}") &&
    !hasDockerRefTagEntry(dockerPublishWorkflowLines),
  "The Docker publish workflow must strip the release tag's v prefix so NOOSPHERE_VERSION resolves to a published image tag.",
);
expect(
  dockerPublishWorkflow.includes('GITHUB_REF_NAME" != "v${version}"') &&
    dockerPublishWorkflow.includes("QEMU_IMAGE: tonistiigi/binfmt:qemu-v10.0.4@sha256:8f58e6214f4cc9dc83ce8f5acad1ece508eb6b20e696a8c1e9f274481982c541") &&
    dockerPublishWorkflowLines.includes("flavor: latest=auto") &&
    dockerPublishWorkflowLines.includes("if: github.ref_type == 'tag'") &&
    dockerPublishWorkflowLines.includes("push: ${{ github.ref_type == 'tag' }}") &&
    !dockerPublishWorkflow.includes("enable={{is_default_branch}}"),
  "The Docker workflow must bind v$VERSION and publish latest only from the canonical application tag.",
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
  coordinatedReleaseGuide.includes("attach the complete\n   six-file installer artifact") &&
    coordinatedReleaseGuide.includes("install.sh` and `install.sh.sha256") &&
    coordinatedReleaseGuide.includes("install-openclaw.sh` and `install-openclaw.sh.sha256") &&
    coordinatedReleaseGuide.includes("--verify-release-files") &&
    coordinatedReleaseGuide.includes("Download all six assets again from the **public** release") &&
    coordinatedReleaseGuide.includes("--verify-release-assets") &&
    coordinatedReleaseGuide.includes("Never move, overwrite, or force-push a published release tag or replace a\n   published release asset"),
  "The coordinated release guide must attach/read back all checksum-owned installer assets before publication.",
);
expect(
  installer.includes("BACKEND_URL='https://raw.githubusercontent.com/SweetSophia/noosphere/624f8e93c57dfd0f048e9702a166b8b245e04008/install-openclaw.sh'") &&
    installer.includes("BACKEND_SHA256='450c2b8a826a207aa927e79ff3926b57215fd0ad7b6f685b156d53ad16cdc174'") &&
    installer.includes("HERMES_BUNDLE_URL='https://github.com/SweetSophia/noosphere/releases/download/v1.13.0/hermes-noosphere-memory-1.13.0.tar.gz'") &&
    installer.includes("HERMES_BUNDLE_SHA256='a560bd8607b512123e71975c188f5b924d4325adaeb86bbbd1424933423c5fde'") &&
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
    installerBackendTest.includes("secret_argv=clean") &&
    installerBackendTest.includes("child_env=clean") &&
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
    installerUxTest.includes("hermes_symlink=blocked") &&
    installerUxTest.includes("hermes_home_symlink=blocked") &&
    installerUxTest.includes("randomized_credentials=yes") &&
    !installerUxTest.includes("fixture-admin-password") &&
    installerUxTest.includes("atomic_secret_rewrite=yes") &&
    installerUxTest.includes("scoped_tool_keys=yes") &&
    installerUxTest.includes("write_key_verified=yes") &&
    installerUxTest.includes("transport_rotation=blocked") &&
    installerUxTest.includes("local_bootstrap_destination=yes") &&
    installerUxTest.includes("port_binding=blocked") &&
    installerUxTest.includes("child_env=clean") &&
    installerUxTest.includes("bootstrap_tool_config=absent") &&
    installerUxTest.includes("secret_argv=clean") &&
    installerPackageTest.includes("tampered backend unexpectedly passed") &&
    installerPackageTest.includes("tampered sibling backend unexpectedly passed") &&
    installerPackageTest.includes("sibling_checksum_sensitive=yes") &&
    installerPackageTest.includes("piped_entrypoint=yes") &&
    installerPackageTest.includes("release_set_verified=yes") &&
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
