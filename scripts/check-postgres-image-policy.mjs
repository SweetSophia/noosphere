#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const verifyRemoteArtifacts = process.argv.includes("--verify-remote");
const immutableHelperRef = "a2067895023efc638e966ee827fea67385d8aa37";
const verifiedInstallerRef = "4a0061a017947825e96b5cc5899914e7d0ed1898";
const verifiedInstallerSha256 = "c0bfacd392c25231144000024f3f880ade5b1304292ec6732ef4efe0389a77a2";
const rawRepositoryUrl = "https://raw.githubusercontent.com/SweetSophia/noosphere";

function read(relativePath) {
  try {
    return readFileSync(resolve(root, relativePath), "utf8");
  } catch (error) {
    failures.push(`Failed to read ${relativePath}: ${error.message}`);
    return "";
  }
}

function parseEnv(relativePath) {
  const values = new Map();

  for (const [index, rawLine] of read(relativePath).split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator <= 0) {
      failures.push(`${relativePath}:${index + 1} is not a KEY=VALUE assignment`);
      continue;
    }

    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (values.has(key)) failures.push(`${relativePath} defines ${key} more than once`);
    values.set(key, value);
  }

  return values;
}

function expect(condition, message) {
  if (!condition) failures.push(message);
}

function countLiteral(text, literal) {
  if (!literal) return 0;
  return text.split(literal).length - 1;
}

function expectExactDbImage(relativePath, image, authorizationKey) {
  const text = read(relativePath);
  const line = `    image: ${image}`;
  expect(
    countLiteral(text, line) === 1,
    `${relativePath} must contain exactly one db image line pinned to ${image}`,
  );
  expect(
    !text.includes("NOOSPHERE_POSTGRES_IMAGE"),
    `${relativePath} must not expose a public PostgreSQL image override`,
  );
  expect(
    !/^\s+image:\s+postgres:[^@\s]+\s*$/m.test(text),
    `${relativePath} must not retain a mutable PostgreSQL image tag`,
  );
  expect(
    text.includes("/proc/1/comm") && text.includes("SELECT 1;") && !text.includes("pg_isready -U noosphere -d noosphere"),
    `${relativePath} must wait for the final PostgreSQL process and a real target-database query`,
  );
  expect(
    text.includes("/run/noosphere-pgvector/candidate-authorized") &&
      text.includes("PostgreSQL candidate authorization is missing") &&
      text.includes("noosphere_postgres_authorization") &&
      text.includes("external: true") &&
      text.includes('command: ["postgres"]'),
    `${relativePath} must refuse candidate startup without guard-created external authorization`,
  );
  expect(
      text.includes("/run/noosphere-pgvector/writer-authorized") &&
      text.includes("Noosphere writer authorization is incomplete") &&
      countLiteral(text, `- ${authorizationKey}:/run/noosphere-pgvector:ro`) === 2 &&
      text.includes('command: ["node", "server.js"]'),
    `${relativePath} must keep the app writer fail closed until guarded completion`,
  );
}

function sha256(relativePath) {
  return createHash("sha256").update(read(relativePath)).digest("hex");
}

function isExecutable(relativePath) {
  try {
    return (statSync(resolve(root, relativePath)).mode & 0o111) !== 0;
  } catch (error) {
    failures.push(`Failed to inspect ${relativePath}: ${error.message}`);
    return false;
  }
}

function extractShellConstant(text, name) {
  return text.match(new RegExp(`^${name}='([a-f0-9]{64})'$`, "m"))?.[1] ?? "";
}

function extractShellStringConstant(text, name) {
  return text.match(new RegExp(`^${name}='([^']+)'$`, "m"))?.[1] ?? "";
}

async function verifyRemoteArtifact(label, url, expectedSha256) {
  try {
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      failures.push(`${label} returned HTTP ${response.status}: ${url}`);
      return;
    }

    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > 2_000_000) {
      failures.push(`${label} exceeded the 2 MB policy limit before download`);
      return;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > 2_000_000) {
      failures.push(`${label} exceeded the 2 MB policy limit`);
      return;
    }
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    expect(
      actualSha256 === expectedSha256,
      `${label} at its immutable ref must match ${expectedSha256}, got ${actualSha256}`,
    );
  } catch (error) {
    failures.push(`${label} could not be verified at its immutable ref: ${error.message}`);
  }
}

const lock = parseEnv("docker/postgres-pgvector/rehearsal.env");
const sourceImage = lock.get("SOURCE_IMAGE") ?? "";
const candidateImage = lock.get("CANDIDATE_IMAGE") ?? "";

for (const [name, value] of [
  ["SOURCE_IMAGE", sourceImage],
  ["CANDIDATE_IMAGE", candidateImage],
]) {
  expect(
    /^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/.test(value),
    `${name} must be an immutable registry digest reference`,
  );
}

expect(sourceImage !== candidateImage, "SOURCE_IMAGE and CANDIDATE_IMAGE must differ");
expectExactDbImage("docker-compose.yml", candidateImage, "postgres_authorization");
expectExactDbImage("docker-compose.noosphere.yml", candidateImage, "noosphere_postgres_authorization");
expectExactDbImage("install-openclaw.sh", candidateImage, "noosphere_postgres_authorization");

const installer = read("install-openclaw.sh");
const helperArtifacts = [
  {
    label: "PostgreSQL switch guard",
    shaConstant: "POSTGRES_SWITCH_SCRIPT_SHA256",
    urlConstant: "POSTGRES_SWITCH_SCRIPT_URL",
    relativePath: "scripts/switch-pgvector-compose.sh",
  },
  {
    label: "deployment verifier",
    shaConstant: "POSTGRES_VERIFY_SCRIPT_SHA256",
    urlConstant: "POSTGRES_VERIFY_SCRIPT_URL",
    relativePath: "scripts/verify-deploy.sh",
  },
];
for (const { shaConstant, urlConstant, relativePath } of helperArtifacts) {
  const expectedUrl = `${rawRepositoryUrl}/${immutableHelperRef}/${relativePath}`;
  expect(
    extractShellConstant(installer, shaConstant) === sha256(relativePath),
    `install-openclaw.sh ${shaConstant} must match ${relativePath}`,
  );
  expect(
    extractShellStringConstant(installer, urlConstant) === expectedUrl,
    `install-openclaw.sh ${urlConstant} must use immutable helper ref ${immutableHelperRef}`,
  );
  expect(
    isExecutable(relativePath),
    `${relativePath} must be executable`,
  );
}

expect(
  installer.includes('if [[ ! -f "$NOOSPHERE_HOME/.env" ]]'),
  "install-openclaw.sh must preserve an existing runtime .env",
);
expect(
  installer.includes("NOOSPHERE_IMAGE=${NOOSPHERE_IMAGE}") &&
    installer.indexOf('env_get "$runtime_env" NOOSPHERE_IMAGE') <
      installer.indexOf('ghcr.io/sweetsophia/noosphere:${NOOSPHERE_VERSION}'),
  "install-openclaw.sh must persist and reload an explicit NOOSPHERE_IMAGE override",
);
for (const [runtimeKey, secretKey] of [
  ["POSTGRES_PASSWORD", "postgresPassword"],
  ["POSTGRES_MIGRATION_PASSWORD", "postgresMigrationPassword"],
  ["POSTGRES_APP_PASSWORD", "postgresAppPassword"],
  ["NEXTAUTH_SECRET", "nextAuthSecret"],
  ["NOOSPHERE_ADMIN_PASSWORD", "adminPassword"],
  ["NOOSPHERE_BOOTSTRAP_API_KEY", "apiKey"],
]) {
  const runtimeLookup = installer.indexOf(`env_get_secret "$NOOSPHERE_HOME/.env" ${runtimeKey}`);
  const derivedLookup = installer.indexOf(`json_get "$SECRETS_FILE" ${secretKey}`);
  expect(
    runtimeLookup >= 0 && derivedLookup > runtimeLookup,
    `install-openclaw.sh must prefer runtime .env ${runtimeKey} over the derived secret-file copy`,
  );
}
expect(
  installer.includes('ensure_runtime_env_secret POSTGRES_MIGRATION_PASSWORD "$POSTGRES_MIGRATION_PASSWORD"') &&
    installer.includes('ensure_runtime_env_secret POSTGRES_APP_PASSWORD "$POSTGRES_APP_PASSWORD"') &&
    installer.includes("PostgreSQL bootstrap, migration, and application passwords must be distinct."),
  "install-openclaw.sh must append missing role-separation secrets without reusing credentials",
);
expect(
  installer.includes("node docker/provision-database-roles.mjs") &&
    installer.indexOf("node docker/provision-database-roles.mjs") <
      installer.indexOf("node docker/migrate-or-baseline.mjs") &&
    installer.includes("postgresql://noosphere_migrator:\\${POSTGRES_MIGRATION_PASSWORD}@db:5432/noosphere") &&
    installer.includes("postgresql://noosphere_app:\\${POSTGRES_APP_PASSWORD}@db:5432/noosphere") &&
    installer.includes('SKIP_MIGRATION: "1"'),
  "install-openclaw.sh must provision roles before migration and run the app with the limited identity",
);
expect(
  installer.includes("--defer-app-restart"),
  "install-openclaw.sh must keep writers stopped until its guarded transaction finishes",
);
expect(
  installer.includes("engine_id=$(docker info --format '{{.ID}}') || {") &&
    installer.includes("Docker engine ID is empty."),
  "install-openclaw.sh must fail closed when Docker engine identity is unavailable",
);
expect(
  installer.includes("incomplete_switch=false") &&
    installer.includes(".mode == \"switch\" and .phase != \"complete\"") &&
    installer.includes('elif [[ "$incomplete_switch" == true ]]') &&
    installer.includes("existing_switch_required=true"),
  "install-openclaw.sh must route a containerless incomplete switch journal back through guarded recovery",
);
const prepareNewInstall = installer.indexOf('"$POSTGRES_SWITCH_SCRIPT" --prepare-new-install');
const finalizeNewInstall = installer.indexOf('"$POSTGRES_SWITCH_SCRIPT" --record-new-install');
const authorizeWriter = installer.indexOf('"$POSTGRES_SWITCH_SCRIPT" --authorize-writer');
const startApp = installer.indexOf("docker compose up -d app");
const candidateGateTemplate = installer.indexOf("marker=/run/noosphere-pgvector/candidate-authorized");
const existingSwitchBlock = installer.indexOf('if [[ "$existing_switch_required" == true ]]');
const existingSwitchDefer = installer.indexOf("--defer-app-restart", existingSwitchBlock);
const newInstallBlock = installer.indexOf('if [[ "$new_install_required" == true ]]', existingSwitchBlock);
const recoveredSwitchResume = installer.indexOf('if [[ "$resume_recovered_switch" == true ]]');
const composeTemplatePublish = installer.indexOf('cat > "$NOOSPHERE_HOME/docker-compose.yml"');
expect(
  candidateGateTemplate >= 0 &&
    existingSwitchBlock > candidateGateTemplate &&
    existingSwitchDefer > existingSwitchBlock &&
    newInstallBlock > existingSwitchDefer,
  "install-openclaw.sh must publish the fail-closed candidate gate before switching an existing volume",
);
expect(
  recoveredSwitchResume >= 0 &&
    composeTemplatePublish > recoveredSwitchResume &&
    installer.includes("Finalizing the verified PostgreSQL source recovery") &&
    installer.includes('exit "$recovered_exit"'),
  "install-openclaw.sh must finalize durable source recovery before publishing the candidate Compose template",
);
expect(
  prepareNewInstall >= 0 && finalizeNewInstall > prepareNewInstall,
  "install-openclaw.sh must prepare a durable new-volume claim before finalizing it",
);
expect(
  authorizeWriter > finalizeNewInstall && startApp > authorizeWriter,
  "install-openclaw.sh must authorize the writer under its inherited lock immediately before starting the app",
);
expect(
  installer.includes('docker_host="unix://$(realpath -m "$docker_socket")"') &&
    installer.includes("printf '%s\\0%s' \"$engine_id\" noosphere_postgres_data"),
  "install-openclaw.sh must canonicalize the local endpoint and lock by Docker engine identity plus volume",
);
expect(
  countLiteral(installer, '"$POSTGRES_VERIFY_SCRIPT"') >= 2,
  "install-openclaw.sh must prepare and execute full deployment verification",
);

for (const relativePath of [
  "openclaw-noosphere-memory/src/cli.ts",
  "openclaw-noosphere-memory/dist/cli.js",
]) {
  const text = read(relativePath);
  expect(
    text.includes(verifiedInstallerRef) &&
      text.includes(verifiedInstallerSha256) &&
      text.includes("sha256sum -c -") &&
      text.indexOf("curl -fsSL") < text.indexOf("sha256sum -c -") &&
      text.indexOf("sha256sum -c -") < text.indexOf('bash "$installer"'),
    `${relativePath} must route setup and upgrades through the immutable checksum-verified installer`,
  );
  expect(
    !text.includes("noosphere/master/install-openclaw.sh") &&
      !text.includes("install-openclaw.sh | bash") &&
      !text.includes('console.log("docker compose pull")') &&
      !text.includes('console.log("docker compose up -d")'),
    `${relativePath} must not advertise a moving-branch installer or unrestricted Compose upgrade`,
  );
}

for (const relativePath of [
  "README.md",
  "README-legacy.md",
  "openclaw-noosphere-memory/README.md",
  "docs/OPENCLAW-OFFICIAL-PLUGIN-SETUP.md",
  "docs/OPENCLAW-OFFICIAL-PLUGIN-DEVELOPMENT-PLAN.md",
  "docs/POSTGRES-PGVECTOR-COMPOSE-UPGRADE.md",
  "docs/articles/noosphere-medium-article.md",
]) {
  const text = read(relativePath);
  expect(
    text.includes(verifiedInstallerRef) &&
      text.includes(verifiedInstallerSha256) &&
      text.includes("sha256sum -c -"),
    `${relativePath} must document the immutable checksum-verified installer`,
  );
  expect(
    !text.includes("noosphere/master/install-openclaw.sh") &&
      !text.includes("install-openclaw.sh | bash"),
    `${relativePath} must not recommend executing a moving-branch installer`,
  );
}

const switchScript = read("scripts/switch-pgvector-compose.sh");
expect(
  !switchScript.includes("imagetools") && !switchScript.includes("docker buildx"),
  "switch-pgvector-compose.sh must verify guarded recovery from local immutable image evidence without registry lookups",
);
expect(
  switchScript.includes("engine_id=$(docker info --format '{{.ID}}') || die") &&
    switchScript.includes("Docker engine ID is empty"),
  "switch-pgvector-compose.sh must fail closed when Docker engine identity is unavailable",
);
expect(
  switchScript.includes("--authorize-writer") &&
    switchScript.includes("writer authorization requires the app container to remain stopped") &&
    switchScript.includes('[[ "$restart_app_after_switch" == false ]] || authorize_writer_marker') &&
    switchScript.includes("deferred source recovery unexpectedly published writer authorization") &&
    switchScript.includes("deferred source app writer restarted unexpectedly"),
  "switch-pgvector-compose.sh must keep writer authorization absent until the inherited installer publishes it",
);
expect(
  switchScript.includes('docker_host="unix://$(realpath -m "$docker_socket")"') &&
    switchScript.includes("printf '%s\\0%s' \"$engine_id\" \"$volume\"") &&
    switchScript.includes("dockerEngineId") &&
    switchScript.includes("dockerEndpoint") &&
    switchScript.includes("transition journal names another Docker engine") &&
    switchScript.includes("transition journal names another Docker endpoint"),
  "switch-pgvector-compose.sh must bind locking and durable evidence to the canonical Docker engine",
);
expect(
  switchScript.includes("--prepare-new-install") &&
    switchScript.includes("io.noosphere.pgvector-new-install-run") &&
    switchScript.includes("claim-created|provisioning|complete"),
  "switch-pgvector-compose.sh must use a resumable, labeled new-install claim",
);
expect(
  switchScript.includes("preparation found evidence for another operation") &&
    switchScript.includes("finalization requires prepared provisioning evidence"),
  "switch-pgvector-compose.sh must not bless an unclaimed candidate volume",
);
expect(
  switchScript.includes("io.noosphere.pgvector-authorization-data") &&
    switchScript.includes("candidate-authorized") &&
    switchScript.includes("assert_candidate_authorization_gate") &&
    switchScript.includes("probeDatabase") &&
    switchScript.includes("recovery-writer-stopped") &&
    switchScript.includes("restore-test volume has invalid recovery ownership") &&
    switchScript.includes("authorize_source_marker") &&
    switchScript.includes("authorize_writer_marker") &&
    switchScript.includes("revoke_writer_marker") &&
    switchScript.includes('gsub(candidate_image, source_image)') &&
    switchScript.includes('gsub(source_image, candidate_image)'),
  "switch-pgvector-compose.sh must provision candidate authorization and rebind recovered desired state to source",
);

const verifyScript = read("scripts/verify-deploy.sh");
const evidenceFileGuard = verifyScript.indexOf('[[ -f "$POSTGRES_EVIDENCE" ]]');
const postgresVersionQuery = verifyScript.indexOf('postgres_version="$(docker exec');
expect(
  verifyScript.includes("candidate verification requires NOOSPHERE_POSTGRES_EVIDENCE") &&
    evidenceFileGuard >= 0 &&
    postgresVersionQuery > evidenceFileGuard &&
    verifyScript.includes('evidence_phase" == complete') &&
    verifyScript.includes('probe="$evidence_probe"') &&
    !verifyScript.includes("noosphere_a2b_verify_"),
  "verify-deploy.sh must require complete transition evidence and use its claimed template0 probe",
);

for (const relativePath of [
  "scripts/switch-pgvector-compose.sh",
  "scripts/verify-deploy.sh",
]) {
  const text = read(relativePath);
  expect(
    countLiteral(text, sourceImage) === 1,
    `${relativePath} must contain the rehearsed source digest exactly once`,
  );
  expect(
    countLiteral(text, candidateImage) === 1,
    `${relativePath} must contain the rehearsed candidate digest exactly once`,
  );
  expect(
    !text.includes("postgres:16-alpine"),
    `${relativePath} must not fall back to a mutable PostgreSQL tag`,
  );
}

expect(
  sha256("install-openclaw.sh") === verifiedInstallerSha256,
  "the checked-in installer bytes must match the checksum advertised by public immutable-install guidance",
);

if (verifyRemoteArtifacts) {
  await verifyRemoteArtifact(
    "public installer",
    `${rawRepositoryUrl}/${verifiedInstallerRef}/install-openclaw.sh`,
    verifiedInstallerSha256,
  );
  for (const { label, shaConstant, urlConstant } of helperArtifacts) {
    await verifyRemoteArtifact(
      label,
      extractShellStringConstant(installer, urlConstant),
      extractShellConstant(installer, shaConstant),
    );
  }
}

if (failures.length > 0) {
  console.error("PostgreSQL image policy check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("PostgreSQL image policy check passed.");
