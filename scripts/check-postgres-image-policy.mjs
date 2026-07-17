#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

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
  return createHash("sha256").update(readFileSync(resolve(root, relativePath))).digest("hex");
}

function extractShellConstant(text, name) {
  return text.match(new RegExp(`^${name}='([a-f0-9]{64})'$`, "m"))?.[1] ?? "";
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
for (const [constant, relativePath] of [
  ["POSTGRES_SWITCH_SCRIPT_SHA256", "scripts/switch-pgvector-compose.sh"],
  ["POSTGRES_VERIFY_SCRIPT_SHA256", "scripts/verify-deploy.sh"],
]) {
  expect(
    extractShellConstant(installer, constant) === sha256(relativePath),
    `install-openclaw.sh ${constant} must match ${relativePath}`,
  );
  expect(
    (statSync(resolve(root, relativePath)).mode & 0o111) !== 0,
    `${relativePath} must be executable`,
  );
}

expect(
  installer.includes('if [[ ! -f "$NOOSPHERE_HOME/.env" ]]'),
  "install-openclaw.sh must preserve an existing runtime .env",
);
for (const [runtimeKey, secretKey] of [
  ["POSTGRES_PASSWORD", "postgresPassword"],
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
  installer.includes("--defer-app-restart"),
  "install-openclaw.sh must keep writers stopped until its guarded transaction finishes",
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
const startApp = installer.indexOf("docker compose up -d app");
const candidateGateTemplate = installer.indexOf("marker=/run/noosphere-pgvector/candidate-authorized");
const existingSwitch = installer.lastIndexOf("--defer-app-restart");
const recoveredSwitchResume = installer.indexOf('if [[ "$resume_recovered_switch" == true ]]');
const composeTemplatePublish = installer.indexOf('cat > "$NOOSPHERE_HOME/docker-compose.yml"');
expect(
  candidateGateTemplate >= 0 && existingSwitch > candidateGateTemplate,
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
  startApp > finalizeNewInstall,
  "install-openclaw.sh must finalize new-install evidence before starting the app writer",
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
    text.includes("install-openclaw.sh | bash"),
    `${relativePath} must route upgrades through the guarded installer`,
  );
  expect(
    !text.includes('console.log("docker compose pull")') &&
      !text.includes('console.log("docker compose up -d")'),
    `${relativePath} must not advertise an unrestricted Compose upgrade`,
  );
}

const switchScript = read("scripts/switch-pgvector-compose.sh");
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
expect(
  verifyScript.includes("candidate verification requires NOOSPHERE_POSTGRES_EVIDENCE") &&
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

if (failures.length > 0) {
  console.error("PostgreSQL image policy check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("PostgreSQL image policy check passed.");
