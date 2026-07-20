#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const verifyRemoteArtifacts = process.argv.includes("--verify-remote");
const immutableHelperRef = "a2067895023efc638e966ee827fea67385d8aa37";
const verifiedInstallerRef = "bebd585efc5e47ddc76e07bced7d9ebc48e4d93f";
const verifiedInstallerSha256 = "79ec7171efb48c6d9b72de19994a49f14f653698fce2f5ee5e542d283361dcf9";
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
      countLiteral(text, `- ${authorizationKey}:/run/noosphere-pgvector:ro`) === 3 &&
      text.includes('command: ["node", "server.js"]'),
    `${relativePath} must keep the app and hybrid worker fail closed until guarded completion`,
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
const hybridMetadata = parseEnv("docker/hybrid-storage/metadata.env");
const sourceImage = lock.get("SOURCE_IMAGE") ?? "";
const candidateImage = lock.get("CANDIDATE_IMAGE") ?? "";
const expectedPostgresVersion = lock.get("EXPECTED_POSTGRES_VERSION") ?? "";
const hybridPostgresVersion = hybridMetadata.get("POSTGRES_VERSION") ?? "";
const hybridPostgresVersionNum = hybridMetadata.get("POSTGRES_SERVER_VERSION_NUM") ?? "";

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
expect(
  hybridPostgresVersion === expectedPostgresVersion &&
    hybridPostgresVersionNum === "160014",
  "hybrid activation metadata must bind the rehearsed PostgreSQL 16.14 runtime and server_version_num=160014",
);
expectExactDbImage("docker-compose.yml", candidateImage, "postgres_authorization");
expectExactDbImage("docker-compose.noosphere.yml", candidateImage, "noosphere_postgres_authorization");
expectExactDbImage("install-openclaw.sh", candidateImage, "noosphere_postgres_authorization");

const installer = read("install-openclaw.sh");
const installerValidationEnv = {
  ...process.env,
  NOOSPHERE_INSTALLER_TEST_MODE: "runtime-env-validation",
};
const safeInstallerValidation = spawnSync("bash", [resolve(root, "install-openclaw.sh")], {
  encoding: "utf8",
  env: { ...installerValidationEnv, NOOSPHERE_INSTALLER_TEST_VALUE: "redis://redis:6379" },
});
const multilineInstallerValidation = spawnSync("bash", [resolve(root, "install-openclaw.sh")], {
  encoding: "utf8",
  env: {
    ...installerValidationEnv,
    NOOSPHERE_INSTALLER_TEST_VALUE: "redis://redis:6379\nINJECTED_ASSIGNMENT=true",
  },
});
expect(
  safeInstallerValidation.status === 0 &&
    multilineInstallerValidation.status !== 0 &&
    multilineInstallerValidation.stderr.includes("must not contain CR or LF characters"),
  "install-openclaw.sh must executable-test rejection of multiline runtime env values",
);
const installerProviderJson = '[{"profileId":"00000000-0000-4000-8000-000000000000","apiKey":"contains-$-and-#"}]';
const installerProviderValidationEnv = {
  ...process.env,
  NOOSPHERE_INSTALLER_TEST_MODE: "hybrid-provider-config-validation",
  NOOSPHERE_HYBRID_PROVIDER_CONFIG_JSON: installerProviderJson,
  NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64: "",
};
const validInstallerProviderValidation = spawnSync("bash", [resolve(root, "install-openclaw.sh")], {
  encoding: "utf8",
  env: installerProviderValidationEnv,
});
const duplicateInstallerProviderValidation = spawnSync("bash", [resolve(root, "install-openclaw.sh")], {
  encoding: "utf8",
  env: {
    ...installerProviderValidationEnv,
    NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64: Buffer.from("[]", "utf8").toString("base64"),
  },
});
const malformedInstallerProviderValidation = spawnSync("bash", [resolve(root, "install-openclaw.sh")], {
  encoding: "utf8",
  env: {
    ...installerProviderValidationEnv,
    NOOSPHERE_HYBRID_PROVIDER_CONFIG_JSON: "",
    NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64: "not-base64",
  },
});
expect(
  validInstallerProviderValidation.status === 0 &&
    validInstallerProviderValidation.stdout.trim() === Buffer.from(installerProviderJson, "utf8").toString("base64") &&
    duplicateInstallerProviderValidation.status !== 0 &&
    malformedInstallerProviderValidation.status !== 0,
  "install-openclaw.sh must executable-test canonical base64 provider configuration without Compose interpolation",
);
const installerHybridCacheJson = JSON.stringify({
  v1: Buffer.alloc(32, 7).toString("base64"),
});
const installerHybridValidationEnv = {
  ...process.env,
  NOOSPHERE_INSTALLER_TEST_MODE: "hybrid-retrieval-config-validation",
  NOOSPHERE_HYBRID_RETRIEVAL_ENABLED: "true",
  NOOSPHERE_HYBRID_QUERY_PROFILE_ID: "00000000-0000-4000-8000-000000000000",
  NOOSPHERE_HYBRID_CACHE_HMAC_ACTIVE_VERSION: "v1",
  NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_JSON: installerHybridCacheJson,
  NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64: "",
};
const validInstallerHybridValidation = spawnSync("bash", [resolve(root, "install-openclaw.sh")], {
  encoding: "utf8",
  env: installerHybridValidationEnv,
});
const ambiguousInstallerHybridValidation = spawnSync("bash", [resolve(root, "install-openclaw.sh")], {
  encoding: "utf8",
  env: { ...installerHybridValidationEnv, NOOSPHERE_HYBRID_RETRIEVAL_ENABLED: "1" },
});
const weakInstallerHybridValidation = spawnSync("bash", [resolve(root, "install-openclaw.sh")], {
  encoding: "utf8",
  env: {
    ...installerHybridValidationEnv,
    NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_JSON: JSON.stringify({ v1: "d2Vhaw==" }),
  },
});
const oversizedInstallerHybridValidation = spawnSync("bash", [resolve(root, "install-openclaw.sh")], {
  encoding: "utf8",
  env: {
    ...installerHybridValidationEnv,
    NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_JSON: "x".repeat(8_193),
  },
});
const inheritedInstallerHybridValidation = spawnSync("bash", [resolve(root, "install-openclaw.sh")], {
  encoding: "utf8",
  env: {
    ...installerHybridValidationEnv,
    NOOSPHERE_HYBRID_CACHE_HMAC_ACTIVE_VERSION: "toString",
  },
});
expect(
  validInstallerHybridValidation.status === 0 &&
    validInstallerHybridValidation.stdout.trim() === Buffer.from(installerHybridCacheJson, "utf8").toString("base64") &&
    ambiguousInstallerHybridValidation.status !== 0 &&
    weakInstallerHybridValidation.status !== 0 &&
    oversizedInstallerHybridValidation.status !== 0 &&
    oversizedInstallerHybridValidation.stderr.includes("exceeds 8192 bytes") &&
    inheritedInstallerHybridValidation.status !== 0,
  "install-openclaw.sh must executable-test disabled-by-default Phase C plus bounded, strong authenticated-cache key material",
);
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
  ["POSTGRES_HYBRID_ADMIN_PASSWORD", "postgresHybridAdminPassword"],
  ["POSTGRES_HYBRID_WORKER_PASSWORD", "postgresHybridWorkerPassword"],
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
    installer.includes('ensure_runtime_env_secret POSTGRES_HYBRID_ADMIN_PASSWORD "$POSTGRES_HYBRID_ADMIN_PASSWORD"') &&
    installer.includes('ensure_runtime_env_secret POSTGRES_HYBRID_WORKER_PASSWORD "$POSTGRES_HYBRID_WORKER_PASSWORD"') &&
    installer.includes('ENV_REWRITE_FILE="$NOOSPHERE_HOME/.env"') &&
    installer.includes('.split(/\\r?\\n/)') &&
    installer.includes('if (/[\\r\\n]/.test(value))') &&
    installer.includes('reject_multiline_env_value POSTGRES_MIGRATION_PASSWORD "$POSTGRES_MIGRATION_PASSWORD"') &&
    installer.includes('reject_multiline_env_value POSTGRES_APP_PASSWORD "$POSTGRES_APP_PASSWORD"') &&
    installer.includes('reject_multiline_env_value POSTGRES_HYBRID_ADMIN_PASSWORD "$POSTGRES_HYBRID_ADMIN_PASSWORD"') &&
    installer.includes('reject_multiline_env_value POSTGRES_HYBRID_WORKER_PASSWORD "$POSTGRES_HYBRID_WORKER_PASSWORD"') &&
    installer.includes('process.stdout.write(`${retained.join("\\n")}\\n`)') &&
    installer.includes("PostgreSQL bootstrap, migration, application, hybrid-admin, and hybrid-worker passwords must be distinct."),
  "install-openclaw.sh must atomically rewrite role-separation secrets with a final newline and without reusing credentials",
);
const writeRuntimeEnvBlock =
  installer.match(/write_runtime_env\(\) \{([\s\S]*?)\n}\n\nensure_runtime_env_secret\(\)/)?.[1] ?? "";
const persistedRuntimeAssignments = Array.from(
  writeRuntimeEnvBlock.matchAll(
    /^([A-Z][A-Z0-9_]*)=\$\{([A-Z][A-Z0-9_]*)(?::-[^}]*)?}$/gm,
  ),
  (match) => [match[1], match[2]],
);
expect(
  persistedRuntimeAssignments.length === 36 &&
    new Set(persistedRuntimeAssignments.map(([name]) => name)).size === 36 &&
    persistedRuntimeAssignments.every(([name, variable]) =>
      installer.includes(`reject_multiline_env_value ${name} "$${variable}"`),
    ),
  "install-openclaw.sh must reject CR/LF in every assignment parsed from its runtime .env writer",
);
const activationScript = read("scripts/activate-hybrid-storage.sh");
const hybridFeatureSchema = read("docker/hybrid-storage/feature-schema.sql");
const hybridActivationSql = read("docker/hybrid-storage/activate.sql");
const hybridValidationSql = read("docker/hybrid-storage/validate.sql");
const phaseBActivationScript = read("scripts/activate-hybrid-worker.sh");
const phaseBFeatureSchema = read("docker/hybrid-storage/phase-b-schema.sql");
const phaseBActivationSql = read("docker/hybrid-storage/activate-phase-b.sql");
const phaseBValidationSql = read("docker/hybrid-storage/validate-phase-b.sql");
const phaseCActivationScript = read("scripts/activate-hybrid-retrieval.sh");
const phaseCFeatureSchema = read("docker/hybrid-storage/phase-c-schema.sql");
const phaseCActivationSql = read("docker/hybrid-storage/activate-phase-c.sql");
const phaseCValidationSql = read("docker/hybrid-storage/validate-phase-c.sql");
const hybridWorkerScript = read("scripts/hybrid-worker.mjs");
expect(
  activationScript.includes("validate_provenance_value source_url") &&
    activationScript.includes("validate_provenance_value built_image_digest") &&
    activationScript.includes('server_version_num" == "$POSTGRES_SERVER_VERSION_NUM') &&
    activationScript.includes('label_postgres_version" == "$POSTGRES_VERSION') &&
    activationScript.includes("^[[:graph:]]+$"),
  "hybrid activation must bind the exact PostgreSQL runtime and bound provenance values before psql substitution",
);
expect(
  hybridFeatureSchema.includes("postgresql_server_version_num integer NOT NULL") &&
    hybridActivationSql.includes(":'postgresql_server_version_num'::integer") &&
    hybridValidationSql.includes("state.postgresql_server_version_num") &&
    hybridValidationSql.includes("'server_version_num'"),
  "hybrid feature evidence must persist and revalidate the exact PostgreSQL runtime",
);
expect(
  phaseBActivationScript.includes("phase_b_source_sha256=$(\n") &&
    phaseBActivationScript.includes("a3_source_sha256=$(\n") &&
    phaseBActivationScript.includes('-v a3_source_sha256="$a3_source_sha256"') &&
    phaseBActivationScript.includes('"$root_dir/docker/hybrid-storage/phase-b-schema.sql"') &&
    phaseBActivationScript.includes('"$root_dir/docker/hybrid-storage/activate-phase-b.sql"') &&
    phaseBActivationScript.includes('"$root_dir/docker/hybrid-storage/validate-phase-b.sql"') &&
    phaseBActivationScript.includes("noosphere_hybrid_admin_login:true") &&
    phaseBActivationScript.includes("noosphere_hybrid_worker_login:true"),
  "Phase B activation must bind all SQL artifacts and verify both limited runtime identities",
);
expect(
  phaseBFeatureSchema.includes("noosphere_hybrid_b.serialize_eligibility()") &&
    phaseBFeatureSchema.includes("noosphere_hybrid_b.authorize_dispatch") &&
    phaseBFeatureSchema.includes("noosphere_hybrid_b.release_stale_job") &&
    phaseBFeatureSchema.includes("profile_backfill_state") &&
    phaseBFeatureSchema.includes("lease_expired_max_attempts") &&
    phaseBFeatureSchema.includes("noosphere_hybrid_b.structural_manifest()") &&
    phaseBFeatureSchema.includes("noosphere_hybrid_b.set_embedding_consent") &&
    phaseBFeatureSchema.includes("noosphere_hybrid_b.enqueue_profile_backfill") &&
    phaseBFeatureSchema.includes("noosphere_hybrid_b.publish_embedding") &&
    phaseBFeatureSchema.includes("profile_coverage < 0.95") &&
    phaseBActivationSql.includes("REVOKE ALL ON ALL FUNCTIONS IN SCHEMA noosphere_hybrid_b FROM PUBLIC") &&
    phaseBActivationSql.includes("\\ir validate.sql") &&
    phaseBActivationSql.includes("'noosphere.activation.sql_sha256', :'a3_source_sha256'") &&
    phaseBActivationSql.includes("REVOKE EXECUTE ON FUNCTION noosphere_hybrid.claim_jobs") &&
    phaseBActivationSql.includes("REVOKE EXECUTE ON FUNCTION noosphere_hybrid.publish_embedding") &&
    phaseBValidationSql.includes("Phase B table, constraint, index, or trigger structure drifted") &&
    phaseBValidationSql.includes("Phase B ACLs exceed the exact owner and capability allowlist") &&
    phaseBValidationSql.includes("noosphere_hybrid_b.authorize_dispatch(uuid,uuid,bigint)") &&
    phaseBValidationSql.includes("noosphere_hybrid_b.release_stale_job(uuid,uuid,bigint,integer)") &&
    hybridWorkerScript.includes("SELECT noosphere_hybrid_b.authorize_dispatch") &&
    hybridWorkerScript.includes("SELECT noosphere_hybrid_b.release_stale_job") &&
    hybridWorkerScript.includes("validateLeaseWindow") &&
    hybridWorkerScript.includes("await client.query(\"COMMIT\")"),
  "Phase B must retain exact A3 proof, dispatch/eligibility serialization, bounded backfill, coverage gating, structural drift detection, and exact ACL validation",
);
expect(
  phaseCActivationScript.includes("phase_c_source_sha256=$(artifact_set_sha256") &&
    phaseCActivationScript.includes('-v a3_source_sha256="$a3_source_sha256"') &&
    phaseCActivationScript.includes('-v phase_b_source_sha256="$phase_b_source_sha256"') &&
    phaseCActivationScript.includes('-v phase_c_source_sha256="$phase_c_source_sha256"') &&
    phaseCFeatureSchema.includes("noosphere_hybrid_c.query_profile_snapshot") &&
    phaseCFeatureSchema.includes("noosphere_hybrid_c.authorize_query_dispatch") &&
    phaseCFeatureSchema.includes("noosphere_hybrid_c.query_profile_coverage") &&
    phaseCFeatureSchema.includes("noosphere_hybrid_c.vector_candidates") &&
    phaseCFeatureSchema.includes("noosphere_hybrid_c.current_vector_membership") &&
    phaseCFeatureSchema.includes("cardinality(candidate_article_ids) > 1000") &&
    phaseCFeatureSchema.includes("Phase C cosine query embedding has zero norm") &&
    phaseCActivationSql.includes("\\ir validate-phase-b.sql") &&
    phaseCActivationSql.includes("GRANT EXECUTE ON FUNCTION noosphere_hybrid_c.authorize_query_dispatch") &&
    phaseCActivationSql.includes("GRANT EXECUTE ON FUNCTION noosphere_hybrid_c.vector_candidates") &&
    phaseCValidationSql.includes("Phase C table, constraint, or index structure drifted") &&
    phaseCValidationSql.includes("NOT acl.is_grantable") &&
    phaseCValidationSql.includes("Phase C ACLs exceed the exact owner and application allowlist"),
  "Phase C activation must revalidate A3+B and expose only the exact application retrieval capability",
);
const applicationDockerfile = read("Dockerfile");
expect(
  applicationDockerfile.includes("/app/scripts/hybrid-provider.mjs ./scripts/hybrid-provider.mjs") &&
    applicationDockerfile.includes("/app/scripts/hybrid-worker.mjs ./scripts/hybrid-worker.mjs") &&
    applicationDockerfile.includes("/app/scripts/check-hybrid-worker-health.mjs ./scripts/check-hybrid-worker-health.mjs") &&
    !applicationDockerfile.includes("/app/scripts ./scripts"),
  "the production image must carry only the Phase B worker runtime scripts, not the repository script tree",
);
for (const composePath of ["docker-compose.yml", "docker-compose.noosphere.yml"]) {
  const compose = read(composePath);
  expect(
    compose.includes("hybrid-worker:") &&
      compose.includes('profiles: ["hybrid"]') &&
    compose.includes("noosphere_hybrid_worker_login:") &&
      compose.includes("export NOOSPHERE_HYBRID_ADMIN_DATABASE_URL=") &&
      compose.includes("export NOOSPHERE_HYBRID_WORKER_DATABASE_URL=") &&
      compose.includes("NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64") &&
      compose.includes("NOOSPHERE_HYBRID_RETRIEVAL_ENABLED: ${NOOSPHERE_HYBRID_RETRIEVAL_ENABLED:-false}") &&
      compose.includes("NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64") &&
      compose.includes("scripts/check-hybrid-worker-health.mjs"),
    `${composePath} must keep the limited Phase B worker behind the disabled hybrid profile`,
  );
}
expect(
  installer.includes("hybrid-worker:") &&
    installer.includes('profiles: ["hybrid"]') &&
    installer.includes("postgresHybridAdminPassword") &&
    installer.includes("postgresHybridWorkerPassword") &&
    installer.includes("export NOOSPHERE_HYBRID_ADMIN_DATABASE_URL=\"postgresql://noosphere_hybrid_admin_login:") &&
    installer.includes("export NOOSPHERE_HYBRID_WORKER_DATABASE_URL=\"postgresql://noosphere_hybrid_worker_login:") &&
    installer.includes("Both Phase B database passwords must be configured together."),
  "install-openclaw.sh must persist distinct Phase B credentials and publish the disabled worker profile",
);
expect(
  installer.includes("NOOSPHERE_HYBRID_RETRIEVAL_ENABLED=\${NOOSPHERE_HYBRID_RETRIEVAL_ENABLED}") &&
    installer.includes("NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64=\${NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64}") &&
    installer.includes("NOOSPHERE_HYBRID_RETRIEVAL_ENABLED: \\${NOOSPHERE_HYBRID_RETRIEVAL_ENABLED:-false}") &&
    installer.includes("NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64: \\${NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64:-}"),
  "install-openclaw.sh must persist Phase C settings while publishing exact recall as disabled by default",
);
const installerProvisionIndexes = Array.from(
  installer.matchAll(/node docker\/provision-database-roles\.mjs/g),
  (match) => match.index,
);
const installerMigrateIndex = installer.indexOf("node docker/migrate-or-baseline.mjs");
const installerBootstrapIndex = installer.indexOf("node docker/bootstrap.mjs");
expect(
  installerProvisionIndexes.length === 2 &&
    installerProvisionIndexes[0] < installerMigrateIndex &&
    installerMigrateIndex < installerProvisionIndexes[1] &&
    installerProvisionIndexes[1] < installerBootstrapIndex &&
    installer.includes("postgresql://noosphere_migrator:\\${POSTGRES_MIGRATION_PASSWORD}@db:5432/noosphere") &&
    installer.includes("postgresql://noosphere_app:\\${POSTGRES_APP_PASSWORD}@db:5432/noosphere") &&
    installer.includes('SKIP_MIGRATION: "1"'),
  "install-openclaw.sh must provision roles before and after migration, then run the app with the limited identity",
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
