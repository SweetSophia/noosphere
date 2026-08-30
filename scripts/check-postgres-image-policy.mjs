#!/usr/bin/env node

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const verifyRemoteArtifacts = process.argv.includes("--verify-remote");
const verifyReleaseArtifacts = process.argv.includes("--verify-release-assets");
const verifyReleaseFiles = process.argv.includes("--verify-release-files");
const releaseRoot = resolve(process.cwd());
const immutableHelperRef = "9da4af0a7b2275aa91eecd102095e0e470bbb0e3";
const guidedInstallerRef = "1f3081b65f146619600a6f90bc43e9b1612e2e01";
const guidedInstallerSha256 = "2117e1696f6fec25470517f504ec0fe7e3ffd4dc331ba05a25d14f06df18ed81";
const guidedBackendRef = "ba16ea7f5de6fb91de01838e46fc07381ff0bc75";
const guidedBackendSha256 = "a5adb6b9a9c12b0816d7e3dcfaa1a1a7d4733ef2904dd69f4730f14835a730cf";
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

const releaseVersion = read("VERSION").trim();
const versionBoundInstallerCommand =
  `NOOSPHERE_VERSION="\${NOOSPHERE_VERSION:-${releaseVersion}}" ` +
  `NOOSPHERE_PLUGIN_SPEC="\${NOOSPHERE_PLUGIN_SPEC:-npm:@sweetsophia/openclaw-noosphere-memory@${releaseVersion}}" ` +
  'bash "$installer" --non-interactive --with openclaw';

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

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readReleaseBytes(filename) {
  try {
    return readFileSync(resolve(releaseRoot, filename));
  } catch (error) {
    failures.push(`Failed to read release file ${filename}: ${error.message}`);
    return Buffer.alloc(0);
  }
}

function readReleaseText(filename) {
  return readReleaseBytes(filename).toString("utf8");
}

function expectedChecksum(checksumText, filename) {
  const match = checksumText.match(/^([a-f0-9]{64})  ([^\r\n]+)\r?\n?$/);
  if (!match || match[2] !== filename) {
    failures.push(`${filename}.sha256 must contain exactly a SHA-256 and ${filename}`);
    return "";
  }
  return match[1];
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

async function verifyRemoteArtifact(
  label,
  url,
  expectedSha256,
  { followRedirects = false } = {},
) {
  try {
    const response = await fetch(url, {
      redirect: followRedirects ? "follow" : "error",
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
const publishedImageEnv = read("noosphere.env.example");
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
const blankInstallerHybridValidation = spawnSync("bash", [resolve(root, "install-openclaw.sh")], {
  encoding: "utf8",
  env: { ...installerHybridValidationEnv, NOOSPHERE_HYBRID_RETRIEVAL_ENABLED: "" },
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
const disabledActiveWithoutKeyringValidation = spawnSync("bash", [resolve(root, "install-openclaw.sh")], {
  encoding: "utf8",
  env: {
    ...installerHybridValidationEnv,
    NOOSPHERE_HYBRID_RETRIEVAL_ENABLED: "false",
    NOOSPHERE_HYBRID_CACHE_HMAC_ACTIVE_VERSION: "v1",
    NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_JSON: "",
    NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64: "",
  },
});
const disabledKeyringWithoutActiveValidation = spawnSync("bash", [resolve(root, "install-openclaw.sh")], {
  encoding: "utf8",
  env: {
    ...installerHybridValidationEnv,
    NOOSPHERE_HYBRID_RETRIEVAL_ENABLED: "false",
    NOOSPHERE_HYBRID_CACHE_HMAC_ACTIVE_VERSION: "",
  },
});
expect(
  validInstallerHybridValidation.status === 0 &&
    validInstallerHybridValidation.stdout.trim() === Buffer.from(installerHybridCacheJson, "utf8").toString("base64") &&
    ambiguousInstallerHybridValidation.status !== 0 &&
    blankInstallerHybridValidation.status !== 0 &&
    blankInstallerHybridValidation.stderr.includes("must be exactly true or false") &&
    weakInstallerHybridValidation.status !== 0 &&
    oversizedInstallerHybridValidation.status !== 0 &&
    oversizedInstallerHybridValidation.stderr.includes("exceeds 8192 bytes") &&
    inheritedInstallerHybridValidation.status !== 0 &&
    disabledActiveWithoutKeyringValidation.status !== 0 &&
    disabledKeyringWithoutActiveValidation.status !== 0,
  "install-openclaw.sh must executable-test disabled-by-default Phase C plus bounded, strong authenticated-cache key material",
);
const helperArtifacts = [
  {
    label: "PostgreSQL transition controller",
    shaConstant: "POSTGRES_CONTROLLER_SCRIPT_SHA256",
    urlConstant: "POSTGRES_CONTROLLER_SCRIPT_URL",
    relativePath: "scripts/run-pgvector-transition-controller.sh",
  },
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
expect(
  installer.includes("NOOSPHERE_VERSION_WAS_EXPLICIT=1") &&
    installer.includes("NOOSPHERE_IMAGE_WAS_EXPLICIT=1") &&
    installer.includes("NOOSPHERE_VERSION_WAS_EXPLICIT == 1 && NOOSPHERE_IMAGE_WAS_EXPLICIT == 0") &&
    installer.includes("NOOSPHERE_IMAGE=''") &&
    installer.includes("Operators retaining a custom registry or") &&
    read("scripts/test-install-openclaw-transition-controller.sh").includes(
      "test_runtime_config_release_version_rebases_persisted_image",
    ),
  "an explicit release version must discard only a stale persisted image while preserving an explicit operator image override",
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
      compose.includes("NOOSPHERE_HYBRID_RETRIEVAL_ENABLED: ${NOOSPHERE_HYBRID_RETRIEVAL_ENABLED-false}") &&
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
    installer.includes("NOOSPHERE_HYBRID_RETRIEVAL_ENABLED: \\${NOOSPHERE_HYBRID_RETRIEVAL_ENABLED-false}") &&
    installer.includes("NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64: \\${NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64:-}"),
  "install-openclaw.sh must persist Phase C settings while publishing exact recall as disabled by default",
);
expect(
  publishedImageEnv.includes("NOOSPHERE_HYBRID_RETRIEVAL_ENABLED=false") &&
    publishedImageEnv.includes("# NOOSPHERE_HYBRID_QUERY_PROFILE_ID=") &&
    publishedImageEnv.includes("# NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64=") &&
    publishedImageEnv.includes("# NOOSPHERE_HYBRID_CACHE_HMAC_ACTIVE_VERSION=") &&
    publishedImageEnv.includes("# NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64=") &&
    publishedImageEnv.includes("# NOOSPHERE_HYBRID_REQUEST_TIMEOUT_MS=30000") &&
    publishedImageEnv.includes("# NOOSPHERE_HYBRID_MAX_RESPONSE_BYTES=4194304"),
  "noosphere.env.example must publish the complete disabled-by-default Phase C surface",
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
  installer.includes('engine_id=$(DOCKER_HOST="$docker_host" docker info --format') &&
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
const transitionRouteMatch = installer.match(
  /^route_postgres_install_transition\(\) \{([\s\S]*?)^}\n\n(?=reconcile_postgres_controller_before_configuration\(\))/m,
);
const transitionRoute = transitionRouteMatch?.[1] ?? "";
const controllerReconciliationMatch = installer.match(
  /^reconcile_postgres_controller_before_configuration\(\) \{([\s\S]*?)^}\n\n(?=acquire_postgres_operation_lock\(\))/m,
);
const controllerReconciliation = controllerReconciliationMatch?.[1] ?? "";
const completeReconciliationStart = controllerReconciliation.indexOf("    complete)");
const incidentReconciliationStart = controllerReconciliation.indexOf("    incident)");
const completeReconciliation =
  completeReconciliationStart >= 0 && incidentReconciliationStart > completeReconciliationStart
    ? controllerReconciliation.slice(completeReconciliationStart, incidentReconciliationStart)
    : "";
const completeGuardClosure = completeReconciliation.indexOf('.mode == "switch" and .phase == "complete"');
const completeLockReacquisition = completeReconciliation.indexOf(
  "reacquire_postgres_operation_lock_from_manifest",
);
const completeControllerCompletion = completeReconciliation.indexOf(
  "controller_transition_completed=true",
);
const existingSwitchBlock = transitionRoute.indexOf('if [[ "$existing_switch_required" == true ]]');
const candidatePull = transitionRoute.indexOf('-f "$POSTGRES_CONTROLLER_CANDIDATE" pull');
const controllerRoleProvisioning = transitionRoute.indexOf(
  'provision_existing_postgres_roles_for_controller "$docker_host" "$docker_path"',
);
const controllerManifest = transitionRoute.indexOf("write_postgres_controller_manifest");
const controllerExecution = transitionRoute.indexOf("run_existing_postgres_controller_transition");
const installerLockReacquisition = transitionRoute.indexOf(
  "reacquire_postgres_operation_lock_from_manifest",
);
const controllerCompletion = transitionRoute.indexOf("controller_transition_completed=true");
const newInstallBlock = transitionRoute.indexOf('if [[ "$new_install_required" == true ]]');
const recoveredSwitchResume = installer.indexOf('if [[ "$resume_recovered_switch" == true ]]');
const composeTemplatePublish = installer.indexOf('cat > "$compose_target"');
expect(
  transitionRouteMatch !== null &&
    !transitionRoute.includes("reconcile_postgres_controller_before_configuration") &&
    !transitionRoute.includes("acquire_postgres_operation_lock() {") &&
    controllerExecution >= 0 &&
    installerLockReacquisition > controllerExecution &&
    controllerCompletion > installerLockReacquisition,
  "installer route policy must be scoped to one function and reacquire the operation lock before post-controller completion",
);
expect(
  controllerReconciliationMatch !== null &&
    !controllerReconciliation.includes("acquire_postgres_operation_lock() {") &&
    completeGuardClosure >= 0 &&
    completeLockReacquisition > completeGuardClosure &&
    completeControllerCompletion > completeLockReacquisition,
  "complete controller reconciliation must bind the manifest operation lock after closure validation and before completion",
);
expect(
  installer.includes("reacquire_postgres_operation_lock_from_manifest() {") &&
    installer.includes("expected_docker_host=$(jq -er '.dockerEndpoint") &&
    installer.includes("expected_engine_id=$(jq -er '.engineId") &&
    installer.includes("expected_lock_root=$(jq -er '.lockRoot") &&
    installer.includes(
      'acquire_postgres_operation_lock "$expected_docker_host" "$expected_engine_id" "$expected_lock_root"',
    ) &&
    installer.includes('[[ -z "$expected_docker_host" || "$docker_host" == "$expected_docker_host" ]]') &&
    installer.includes('[[ -z "$expected_engine_id" || "$engine_id" == "$expected_engine_id" ]]') &&
    installer.includes(
      '[[ $(realpath -m "$ambient_lock_root") == "$(realpath -m "$expected_lock_root")" ]]',
    ) &&
    installer.includes("Runtime lock directory changed while the PostgreSQL transition controller was active."),
  "post-controller lock reacquisition must remain bound to the manifest Docker endpoint, engine identity, and lock root",
);
expect(
  installer.includes(
    "# Route only real source transitions through the controller. New installs keep\n" +
      "# a direct guard claim; already-complete installations need neither pre-step.\n" +
      "route_postgres_install_transition",
  ),
  "installer transition routing commentary must remain non-executable before the main route call",
);
const installerMain = installer.indexOf("\nmain() {");
const earlyControllerReconciliation = installer.indexOf(
  "\nreconcile_postgres_controller_before_configuration\n",
  installerMain,
);
const firstRuntimeSecretWrite = installer.indexOf("ensure_runtime_env_secret ", installerMain);
expect(
  installer.includes("assert_installer_owned_regular_file \"$POSTGRES_CONTROLLER_STATE\"") &&
    installer.includes(".guardJournalEvidence.sha256") &&
    installer.includes('actual_guard_sha=$(sha256sum "$guard_evidence"') &&
    installer.includes('[[ "$actual_guard_sha" == "$expected_guard_sha" ]]') &&
    installer.includes('.mode == "switch" and .phase == "complete"') &&
    installer.includes("controller_transition_completed=true") &&
    earlyControllerReconciliation >= 0 &&
    firstRuntimeSecretWrite > earlyControllerReconciliation,
  "complete/nonterminal controller state must reconcile before installer runtime-secret writes",
);
expect(
  installer.includes("sanitize_postgres_controller_environment() {") &&
    installer.includes("postgres_controller_compose_version_signature() (") &&
    installer.includes("postgres_controller_compose_model_signature() (") &&
    installer.includes("DOCKER_*|COMPOSE_*) unset") &&
    installer.includes("unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY") &&
    installer.includes("unset NOOSPHERE_A2B_LOCK_FD NOOSPHERE_A2B_LOCK_PATH") &&
    installer.includes("unset NOOSPHERE_CONTROLLER_TEST_INTERRUPT_AFTER_INTENT") &&
    installer.includes("export COMPOSE_DISABLE_ENV_FILE=1") &&
    installer.includes("compose_version_sha=$(postgres_controller_compose_version_signature") &&
    installer.includes("effective_compose_sha=$(postgres_controller_compose_model_signature"),
  "installer must hash the effective candidate Compose model under the controller's sanitized environment",
);
expect(
  installer.includes('fsync_installer_path "$POSTGRES_CONTROLLER_SCRIPT"') &&
    installer.includes('fsync_installer_path "$POSTGRES_SWITCH_SCRIPT"') &&
    installer.includes('fsync_installer_path "$POSTGRES_VERIFY_SCRIPT"') &&
    installer.includes('for bound_input in \\') &&
    installer.includes('assert_installer_owned_regular_file "$bound_input"') &&
    installer.includes('fsync_installer_path "$bound_input"'),
  "installer must fsync every mutable controller-bound input before manifest preparation",
);
expect(
  installer.includes('systemctl --user show "$unit" -p LoadState --value') &&
    installer.includes('if [[ "$unit_load_state" != not-found ]]'),
  "installer must distinguish an absent transient unit by LoadState=not-found rather than systemctl exit status",
);
expect(
  candidateGateTemplate >= 0 &&
    existingSwitchBlock >= 0 &&
    candidatePull > existingSwitchBlock &&
    controllerRoleProvisioning > candidatePull &&
    controllerManifest > controllerRoleProvisioning &&
    controllerExecution > controllerManifest &&
    newInstallBlock > controllerExecution &&
    transitionRoute.includes('controller_transition_completed=true') &&
    installer.includes('compose_target="$POSTGRES_CONTROLLER_CANDIDATE"') &&
    installer.includes('install -m 600 "$NOOSPHERE_HOME/docker-compose.yml" "$POSTGRES_CONTROLLER_SOURCE"'),
  "install-openclaw.sh must preserve source Compose bytes and route existing volumes through candidate pull, role provisioning, manifest preparation, and the controller",
);
expect(
  installer.includes("provision_existing_postgres_roles_for_controller() {") &&
    installer.includes('map(select((.value.Aliases // []) | index("db")))') &&
    installer.includes('run --rm --pull never \\') &&
    installer.includes('--network "$db_network"') &&
    installer.includes('--env-file "$role_env"') &&
    installer.includes('provision_log=$(mktemp) || {') &&
    installer.includes('chmod 0600 "$role_env" "$provision_log"') &&
    installer.includes('rm -f "$role_env" "$provision_log"') &&
    installer.includes('NOOSPHERE_BOOTSTRAP_DATABASE_URL=postgresql://noosphere:${POSTGRES_PASSWORD}@db:5432/noosphere') &&
    installer.includes('DATABASE_URL=postgresql://noosphere_migrator:${POSTGRES_MIGRATION_PASSWORD}@db:5432/noosphere') &&
    installer.includes('NOOSPHERE_APP_DATABASE_URL=postgresql://noosphere_app:${POSTGRES_APP_PASSWORD}@db:5432/noosphere') &&
    installer.includes('"$NOOSPHERE_IMAGE" docker/provision-database-roles.mjs') &&
    installer.includes("Database role provisioning for the existing PostgreSQL transition failed"),
  "existing-volume transitions must provision released v1.11 database roles with the candidate role-only helper before controller preparation",
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
  installer.includes("resolve_local_docker_endpoint() {") &&
    installer.includes("printf 'unix://%s\\n' \"$(realpath -m \"$docker_socket\")\"") &&
    installer.includes("printf '%s\\0%s' \"$engine_id\" noosphere_postgres_data"),
  "install-openclaw.sh must canonicalize the local endpoint and lock by Docker engine identity plus volume",
);
expect(
  countLiteral(installer, '"$POSTGRES_VERIFY_SCRIPT"') >= 2,
  "install-openclaw.sh must prepare and execute full deployment verification",
);
expect(
  installer.includes(
    `PLUGIN_SPEC="\${NOOSPHERE_PLUGIN_SPEC:-npm:@sweetsophia/openclaw-noosphere-memory@${releaseVersion}}"`,
  ) &&
    installer.includes(`NOOSPHERE_VERSION="\${NOOSPHERE_VERSION:-${releaseVersion}}"`) &&
    installer.includes('PLUGIN_INSTALL_ARGS=(plugins install "$PLUGIN_SPEC" --force)') &&
    installer.includes('if [[ "$PLUGIN_SPEC" == npm:* ]]') &&
    installer.includes('PLUGIN_INSTALL_ARGS+=(--pin)') &&
    installer.includes('openclaw "${PLUGIN_INSTALL_ARGS[@]}"') &&
    !installer.includes('openclaw plugins update "$PLUGIN_ID"'),
  "install-openclaw.sh must default app and plugin to one release, force deterministic reinstall, and pin npm specs",
);
expect(
  installer.includes("verify_min_articles=1") &&
    installer.includes('if [[ "$new_install_required" == true ]]') &&
    installer.includes("verify_min_articles=0") &&
    installer.includes('NOOSPHERE_MIN_ARTICLES="$verify_min_articles"'),
  "install-openclaw.sh must allow zero articles only for a proven new install",
);
const mainTransitionRouteCall = installer.lastIndexOf("\nroute_postgres_install_transition\n");
const mainStopBeforeBootstrap = installer.indexOf(
  'echo "Stopping Noosphere app before schema/bootstrap work..."',
  mainTransitionRouteCall,
);
const mainBootstrap = installer.indexOf(
  'echo "Applying database schema and bootstrap data..."',
  mainTransitionRouteCall,
);
expect(
  mainTransitionRouteCall >= 0 &&
    mainStopBeforeBootstrap > mainTransitionRouteCall &&
    mainBootstrap > mainStopBeforeBootstrap &&
    !installer.includes('if [[ "$controller_transition_completed" != true ]]'),
  "controller completion must still stop the app and run idempotent schema/bootstrap work before final activation",
);
expect(
  installer.includes(`if docker inspect noosphere-openclaw-app >/dev/null 2>&1 &&
   [[ "$(docker inspect noosphere-openclaw-app --format '{{.State.Running}}')" == true ]]; then
  echo "Stopping Noosphere app before schema/bootstrap work..."
  docker stop --time 60 noosphere-openclaw-app >/dev/null
fi
echo "Starting Noosphere at \${APP_URL}..."`),
  "install-openclaw.sh must stop a running app before direct schema/bootstrap work",
);
expect(
  installer.includes(`local -a systemd_args=()
  release_postgres_operation_lock
  if [[ ! -e "$POSTGRES_CONTROLLER_STATE" ]]; then
    "$POSTGRES_CONTROLLER_SCRIPT" --prepare`),
  "install-openclaw.sh must release the parent operation lock before controller preparation",
);

for (const relativePath of [
  "openclaw-noosphere-memory/src/cli.ts",
  "openclaw-noosphere-memory/dist/cli.js",
]) {
  const text = read(relativePath);
  expect(
    text.includes(guidedInstallerRef) &&
      text.includes(guidedInstallerSha256) &&
      text.includes("VERIFIED_NOOSPHERE_VERSION") &&
      text.includes(releaseVersion) &&
      text.includes("NOOSPHERE_VERSION") &&
      text.includes('"  set -e"') &&
      text.includes(`trap \\'rm -f "$installer"\\' EXIT`) &&
      text.includes("sha256sum -c -") &&
      text.indexOf("curl -fsSL") < text.indexOf("sha256sum -c -") &&
      text.indexOf("sha256sum -c -") < text.indexOf('bash "$installer"') &&
      !text.includes('bash "$installer" && rm -f "$installer"'),
    `${relativePath} must route setup and upgrades through a fail-fast, cleanup-safe immutable installer block`,
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
  "README-legacy.md",
  "openclaw-noosphere-memory/README.md",
  "docs/OPENCLAW-OFFICIAL-PLUGIN-SETUP.md",
  "docs/OPENCLAW-OFFICIAL-PLUGIN-DEVELOPMENT-PLAN.md",
  "docs/POSTGRES-PGVECTOR-COMPOSE-UPGRADE.md",
  "docs/articles/noosphere-medium-article.md",
]) {
  const text = read(relativePath);
  const checksumCount = countLiteral(text, "sha256sum -c -");
  const safeInstallerBlocks = Array.from(
    text.matchAll(
      /^(\s*)\(\n\1  set -e\n\1  installer="\$\(mktemp\)"\n\1  trap 'rm -f "\$installer"' EXIT\n\1  curl -fsSL [^\n]+ -o "\$installer"\n\1  printf '[^\n]+' '[a-f0-9]{64}' "\$installer" \| sha256sum -c -\n\1  NOOSPHERE_VERSION="\$\{NOOSPHERE_VERSION:-[0-9]+\.[0-9]+\.[0-9]+\}" NOOSPHERE_PLUGIN_SPEC="\$\{NOOSPHERE_PLUGIN_SPEC:-npm:@sweetsophia\/openclaw-noosphere-memory@[0-9]+\.[0-9]+\.[0-9]+\}" bash "\$installer" --non-interactive --with openclaw\n(?:\1  openclaw noosphere (?:doctor|status)\n)*\1\)$/gm,
    ),
  ).length;
  expect(
    text.includes(guidedInstallerRef) &&
      text.includes(guidedInstallerSha256) &&
      text.includes(versionBoundInstallerCommand) &&
      checksumCount > 0 &&
      safeInstallerBlocks === checksumCount,
    `${relativePath} must gate every immutable installer execution on checksum success and trap cleanup`,
  );
  expect(
    !/^\s*\)\n\s*openclaw noosphere (?:doctor|status)$/m.test(text),
    `${relativePath} must keep immediate post-install checks inside the fail-fast installer subshell`,
  );
  expect(
    !text.includes("noosphere/master/install-openclaw.sh") &&
      !text.includes("install-openclaw.sh | bash"),
    `${relativePath} must not recommend executing a moving-branch installer`,
  );
}

const readme = read("README.md");
const installationGuide = read("docs/INSTALLATION.md");
const guidedLauncherDocs = [
  "README.md",
  "docs/INSTALLATION.md",
  "docs/OPENCLAW-OFFICIAL-PLUGIN-SETUP.md",
  "openclaw-noosphere-memory/README.md",
  "opencode-noosphere-memory/README.md",
  "kilocode-noosphere-memory/README.md",
];
for (const relativePath of guidedLauncherDocs) {
  const text = read(relativePath);
  expect(
    text.includes(`${rawRepositoryUrl}/${guidedInstallerRef}/install.sh`) &&
      !text.includes("/master/install.sh") &&
      !text.includes("/main/install.sh"),
    `${relativePath} must pin the reviewed guided launcher without a moving-branch fallback`,
  );
}
const hermesBundleReadme = read("hermes-noosphere-memory/README.md");
expect(
  !hermesBundleReadme.includes("raw.githubusercontent.com/SweetSophia/noosphere/") &&
    hermesBundleReadme.includes("avoids a circular bundle-to-launcher pin"),
  "The bundled Hermes README must delegate guided launcher ownership without embedding a circular launcher pin",
);
const guidedOneLiner =
  `curl -fsSL ${rawRepositoryUrl}/${guidedInstallerRef}/install.sh | bash`;
expect(
  readme.includes(guidedInstallerRef) &&
    !readme.includes("/master/install.sh") &&
    !readme.includes("/main/install.sh"),
  "README.md must pin the guided launcher commit without a moving-branch fallback",
);
expect(
  installationGuide.includes(guidedInstallerRef) &&
    installationGuide.includes(guidedInstallerSha256) &&
    !installationGuide.includes("/master/install.sh") &&
    !installationGuide.includes("/main/install.sh"),
  "docs/INSTALLATION.md must pin the guided launcher commit and checksum without a moving-branch fallback",
);
expect(
  readme.includes(guidedOneLiner) &&
    readme.includes("~/.noosphere/credentials.json") &&
    readme.includes("--dry-run --core-only") &&
    readme.includes("noosphere_postgres_data") &&
    readme.includes("docs/INSTALLATION.md") &&
    readme.includes("a merged commit alone is not a release") &&
    installationGuide.includes("Merging the installer source does not by") &&
    installationGuide.includes("all six installer assets"),
  "README.md and docs/INSTALLATION.md must keep novice guidance, protected state, and the pre-release artifact boundary synchronized",
);
expect(
  installationGuide.includes("## Fresh install versus upgrade") &&
    installationGuide.includes("## Manual Docker Compose installation") &&
    installationGuide.includes("### Bootstrap credential file rules") &&
    installationGuide.includes("NOOSPHERE_BOOTSTRAP_SECRETS_FILE=/app/uploads/bootstrap-secrets/secrets.json") &&
    installationGuide.includes("mode `0600`") &&
    installationGuide.includes("mode `0700`") &&
    installationGuide.includes("directly under shared directories") &&
    installationGuide.includes("sha256sum -c -"),
  "docs/INSTALLATION.md must preserve advanced bootstrap-secret protections, manual deployment, upgrade separation, and the auditable launcher path",
);

const switchScript = read("scripts/switch-pgvector-compose.sh");
const controllerScript = read("scripts/run-pgvector-transition-controller.sh");
const verifyDeployScript = read("scripts/verify-deploy.sh");
expect(
  switchScript.includes("digest_role()") &&
    switchScript.includes("noosphere_migrator|noosphere") &&
    switchScript.includes("released v1.11 cluster does not have that role yet") &&
    !switchScript.includes("pg_dump -U noosphere_migrator"),
  "switch-pgvector-compose.sh must inspect released legacy clusters without assuming the 1.12 migration role already exists",
);
expect(
  controllerScript.includes("NOOSPHERE_VERIFY_APP_HEALTH=false") &&
    verifyDeployScript.includes('VERIFY_APP_HEALTH="${NOOSPHERE_VERIFY_APP_HEALTH:-true}"') &&
    verifyDeployScript.includes("health_status=skipped") &&
    verifyDeployScript.includes('if [[ "$VERIFY_APP_HEALTH" == true ]]'),
  "deferred source recovery must verify database continuity without requiring the intentionally stopped app writer",
);
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
    switchScript.includes("cleanup_rehearsal_resources") &&
    switchScript.includes('docker volume inspect "$current" --format \'{{json .Labels}}\'') &&
    switchScript.includes("refusing unlabelled volume removal") &&
    switchScript.includes("authorize_source_marker") &&
    switchScript.includes("authorize_writer_marker") &&
    switchScript.includes("revoke_writer_marker") &&
    switchScript.includes("assert_authorization_marker_file") &&
    switchScript.includes("assert_authorization_marker_content") &&
    switchScript.includes("authorization_marker_path_present") &&
    switchScript.includes("assert_legacy_authorization_state") &&
    switchScript.includes("assert_pending_authorization_state") &&
    switchScript.includes("normalize_legacy_authorization_state") &&
    switchScript.includes("publish_authorization_marker") &&
    switchScript.includes('sha256sum "/authorization/$1"') &&
    switchScript.includes("printf '%s\\n' \"$1\" | sha256sum") &&
    switchScript.includes('[ -e "$path" ] || [ -L "$path" ]') &&
    switchScript.includes('[ -f "$path" ] && [ ! -L "$path" ] || exit 1') &&
    switchScript.includes('"$(stat -c "%u:%g:%a" "$path")" = "0:0:644"') &&
    switchScript.includes('temp=$(mktemp "/authorization/.$marker.XXXXXX")') &&
    switchScript.includes('mv -f -- "$temp" "$target"') &&
    !switchScript.includes("> /authorization/$AUTH_MARKER.tmp") &&
    !switchScript.includes("> /authorization/$WRITER_MARKER.tmp") &&
    !switchScript.includes(".source-$run_id.tmp") &&
    switchScript.includes("0:0:600|0:0:644") &&
    switchScript.includes(
      'assert_pending_authorization_state "$CANDIDATE_IMAGE" "$stored_platform"',
    ) &&
    switchScript.includes(
      'assert_legacy_authorization_state "$CANDIDATE_IMAGE" absent "$stored_platform"',
    ) &&
    switchScript.includes(
      "pending authorization state unexpectedly contains writer authorization",
    ) &&
    switchScript.includes('gsub(candidate_image, source_image)') &&
    switchScript.includes('gsub(source_image, candidate_image)'),
  "switch-pgvector-compose.sh must reject unsafe marker paths and inexact bytes, normalize legacy root-owned mode-0600 markers, enforce mode 0644, and rebind recovered desired state to source",
);
const recoveredEvidenceValidation = switchScript.indexOf(
  'stored_authorization_fingerprint=$(jq -er \'.authorizationVolumeFingerprint\' "$journal")',
);
const recoveredSourceStateValidation = switchScript.indexOf(
  'assert_legacy_authorization_state "$SOURCE_IMAGE" optional "$stored_platform"',
  recoveredEvidenceValidation,
);
const recoveredMutation = switchScript.indexOf(
  'if [[ "$journal_phase" == recovered ]]; then\n' +
    '    stop_app_writer_for_recovery',
);
expect(
  recoveredEvidenceValidation >= 0 &&
    recoveredSourceStateValidation > recoveredEvidenceValidation &&
    recoveredMutation > recoveredSourceStateValidation &&
    !switchScript.includes("true) recovered_writer_policy=required") &&
    !switchScript.includes("false) recovered_writer_policy=absent"),
  "switch-pgvector-compose.sh must accept either exact source writer-marker state when historical recovered evidence did not persist the recovery restart policy",
);
expect(
  switchScript.includes("empty_authorization_marker_digest()") &&
    switchScript.includes(
      '[[ "$actual_digest" == "$(empty_authorization_marker_digest)" ]] ||\n' +
        '      die "pending authorization marker must remain empty: $AUTH_MARKER"',
    ),
  "switch-pgvector-compose.sh must accept only a metadata-safe zero-length pending candidate marker before publication",
);
const existingJournalValidation = switchScript.indexOf(
  'if path_present "$journal"; then\n  validate_journal',
);
const firstManagedMutationActivation = switchScript.indexOf(
  'fail_closed_on_die=true\n      recover_source',
  existingJournalValidation,
);
expect(
  existingJournalValidation >= 0 &&
    firstManagedMutationActivation > existingJournalValidation &&
    switchScript.includes('path_present() {\n  [[ -e "$1" || -L "$1" ]]') &&
    switchScript.includes('if path_present "$target"; then\n    assert_owned_regular_file "$target"') &&
    switchScript.includes('[[ "$fail_closed_on_die" == true ]] || exit "$status"'),
  "switch-pgvector-compose.sh must leave a running app untouched when journal or marker preflight validation fails",
);
const freshStaleState = switchScript.indexOf("stale_authorization_fingerprint=''");
const freshStalePreflight = switchScript.indexOf(
  'assert_stale_authorization_volume "$app_was_running"',
  freshStaleState,
);
const freshStaleFailClosed = switchScript.indexOf(
  "fail_closed_on_die=true",
  freshStalePreflight,
);
const legacyBinding = switchScript.indexOf(
  "bind_legacy_recovered_authorization_volume()",
);
const legacyBindingVolumeRevalidation = switchScript.indexOf(
  'current_fingerprint=$(assert_authorization_volume "$expected_fingerprint" false "$target_platform")',
  legacyBinding,
);
const legacyBindingFinalValidation = switchScript.indexOf(
  '  assert_authorization_volume "$expected_fingerprint" false "$target_platform" >/dev/null\n' +
    '  assert_legacy_authorization_state "$expected_image" "$writer_policy" "$target_platform"\n' +
    '  write_json_atomic "$journal" "$temp"',
  legacyBindingVolumeRevalidation,
);
expect(
  freshStaleState >= 0 &&
    freshStalePreflight > freshStaleState &&
    freshStaleFailClosed > freshStalePreflight &&
    switchScript.includes(
      'authorizationVolumeFingerprint:(if $authorizationVolumeFingerprint == "" then null else $authorizationVolumeFingerprint end)',
    ) &&
    switchScript.includes("transition authorization volume appeared after its journal claim") &&
    switchScript.includes("bind_legacy_recovered_authorization_volume") &&
    switchScript.includes('assert_authorization_volume \'\' false "$stored_platform"') &&
    switchScript.includes(
      '"$legacy_recovered_authorization_fingerprint" "$SOURCE_IMAGE" optional "$stored_platform"',
    ) &&
    legacyBindingVolumeRevalidation > legacyBinding &&
    legacyBindingFinalValidation > legacyBindingVolumeRevalidation &&
    switchScript.includes('[.[0].Mounts[] | select(.Name == $volume)]') &&
    switchScript.includes('.[0].Destination == "/run/noosphere-pgvector"') &&
    switchScript.includes(".[0].RW == false"),
  "switch-pgvector-compose.sh must validate journal-bound marker state and read-only consumers immediately before binding early authorization evidence",
);

const switchTestScript = read("scripts/test-pgvector-compose-switch.sh");
expect(
  switchTestScript.includes(
    'switch_script=${PGVECTOR_SWITCH_FIXTURE_SCRIPT:-"$ROOT_DIR/scripts/switch-pgvector-compose.sh"}',
  ) &&
    switchTestScript.includes("command jq \"$@\" || status=$?") &&
    switchTestScript.includes(
      "[[ $(<\"$fixture_log\") == 'fixture: candidate-authorization volume fingerprint changed' ]]",
    ) &&
    switchTestScript.includes('[[ $(<"$assert_count_file") == 2 ]]') &&
    switchTestScript.includes('[[ ! -e "$write_called_file" ]]') &&
    switchTestScript.includes(
      "Historical recovered evidence with appWasRunning=false and writer authorization was not archived",
    ) &&
    switchTestScript.includes(
      "Deferred legacy recovered evidence with appWasRunning=true unexpectedly reported switch success",
    ) &&
    switchTestScript.includes(
      "Unversioned legacy journal did not select signature version 1",
    ) &&
    switchTestScript.includes(
      "Versioned journal did not select signature version 2",
    ) &&
    switchTestScript.includes("Unsupported data signature version was accepted") &&
    switchTestScript.includes(
      "Recovery writer-stop accepted a failed container classification as absence",
    ),
  "test-pgvector-compose-switch.sh must prove historical recovery compatibility, fail-closed writer classification, signature-version dispatch, and post-render mutation rejection",
);

const digestTestScript = read("scripts/test-digest-order-independence.sh");
const postgresRehearsalWorkflow = read(
  ".github/workflows/postgres-pgvector-rehearsal.yml",
);
const workflowJob = (source, name) => {
  const start = source.indexOf(`  ${name}:\n`);
  if (start < 0) return "";
  const remainder = source.slice(start + 3);
  const nextJob = remainder.search(/^  [a-z0-9][a-z0-9-]*:\n/m);
  return nextJob < 0 ? source.slice(start) : source.slice(start, start + 3 + nextJob);
};
const shellFunctionDeclarationPattern = (name) => {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|[^A-Za-z0-9_])(?:${escapedName}[ \\t]*\\([ \\t]*\\)|function[ \\t]+${escapedName}(?:[ \\t]*\\([ \\t]*\\))?)[ \\t]*(?:\\{|(?:#.*)?$)`,
    "gm",
  );
};
const anyShellFunctionDeclarationPattern =
  /(?:^|[^A-Za-z0-9_])(?:[A-Za-z_][A-Za-z0-9_]*[ \t]*\([ \t]*\)|function[ \t]+[A-Za-z_][A-Za-z0-9_]*(?:[ \t]*\([ \t]*\))?)[ \t]*(?:\{|(?:#.*)?$)/m;
const dynamicShellDefinitionPattern =
  /(?:^|[\s;&|(){}])(?:alias(?:\s|$)|shopt[ \t]+-s[ \t]+expand_aliases(?:[\s;&|]|$))/m;
const normalizeShellLineContinuations = (source) => source.replace(/\\\n/g, "");
const shellFunction = (source, name) => {
  const signature = `${name}() {`;
  const declarationSource = normalizeShellLineContinuations(source);
  if (dynamicShellDefinitionPattern.test(declarationSource)) return "";
  const definitionCount = declarationSource.match(shellFunctionDeclarationPattern(name))?.length ?? 0;
  if (definitionCount !== 1) return "";
  const start = source.indexOf(signature);
  const end = source.indexOf("\n}\n", start);
  return start >= 0 && end > start ? source.slice(start, end + 3) : "";
};
const duplicateFunctionProbes = [
  "probe() {\n  printf safe\n}\nprobe() {\n  printf unsafe\n}\n",
  "probe() {\n  printf safe\n}\nfunction probe() {\n  printf unsafe\n}\n",
  "probe() {\n  printf safe\n}\nfunction probe {\n  printf unsafe\n}\n",
  "probe() {\n  printf safe\n}\nprobe () {\n  printf unsafe\n}\n",
  "probe() {\n  printf safe\n}\nfunction probe()\n{\n  printf unsafe\n}\n",
  "probe() {\n  printf safe\n}\ntrue; probe() { printf unsafe; }\n",
  "probe() {\n  printf safe\n}\nif true; then function probe { printf unsafe; }; fi\n",
  "probe() {\n  printf safe\n}\npro\\\nbe() { printf unsafe; }\n",
  "probe() {\n  printf safe\n}\nprobe\\\n() { printf unsafe; }\n",
  "probe() {\n  printf safe\n}\nprobe() \\\n{ printf unsafe; }\n",
  "probe() {\n  printf safe\n}\nshopt -s expand_aliases\nalias redefine='pro''be() { printf unsafe; }'\nredefine\n",
];
expect(
  duplicateFunctionProbes.every((source) => shellFunction(source, "probe") === ""),
  "shell policy extraction must reject duplicate function definitions",
);
const digestPsqlFunction = shellFunction(switchScript, "_digest_psql");
const digestObjectSignatureFunction = shellFunction(
  switchScript,
  "_digest_object_signature",
);
const supportedDataObjectsFunction = shellFunction(
  switchScript,
  "_assert_supported_data_objects",
);
const dataInventoryFunction = shellFunction(
  switchScript,
  "_collect_data_inventory",
);
const normalizedDumpFunction = shellFunction(switchScript, "normalized_dump");
const legacyDumpFunction = shellFunction(switchScript, "legacy_normalized_dump");
const migratorSqlFunction = shellFunction(switchScript, "migrator_sql");
const migrationSignatureFunction = shellFunction(
  switchScript,
  "migration_signature",
);
const logicalBackupFunction = shellFunction(
  switchScript,
  "create_logical_backup",
);
const digestRoleFunction = shellFunction(switchScript, "digest_role");
const expectedDigestPsqlFunction = [
  "_digest_psql() {",
  "  local container=$1 query=$2 role",
  '  role=$(digest_role "$container")',
  '  docker exec "$container" psql -XAtq -v ON_ERROR_STOP=1 -U "$role" -d noosphere -c "$query"',
  "}",
  "",
].join("\n");
expect(
  digestRoleFunction.includes("noosphere_migrator|noosphere") &&
    digestRoleFunction.includes("NOT rolsuper") &&
    digestRoleFunction.includes("invalid-migrator") &&
    digestPsqlFunction === expectedDigestPsqlFunction &&
    !normalizedDumpFunction.includes("SET ROLE pg_read_all_data") &&
    normalizedDumpFunction.includes('role=$(digest_role "$container")') &&
    normalizedDumpFunction.includes('pg_dump -U "$role" ') &&
    legacyDumpFunction.includes('role=$(digest_role "$container")') &&
    legacyDumpFunction.includes('pg_dump -U "$role" ') &&
    digestObjectSignatureFunction.includes(
      '_digest_psql "$container" "$query" | sha256sum | awk',
    ) &&
    normalizedDumpFunction.includes("_digest_object_signature") &&
    !normalizedDumpFunction.includes("=$(_digest_psql"),
  "digest generation must prefer a non-superuser production role and permit only the released legacy-owner fallback",
);
expect(
  migratorSqlFunction.includes('role=$(digest_role "$container")') &&
    migratorSqlFunction.includes('-U "$role" ') &&
    migrationSignatureFunction.includes('migrator_sql "$1" noosphere') &&
    logicalBackupFunction.includes('role=$(digest_role "$container")') &&
    logicalBackupFunction.includes('pg_dump -U "$role" ') &&
    switchScript.includes(
      'create_logical_backup "$source_maintenance" "$backup_temp"',
    ) &&
    switchTestScript.includes("test_migrator_producer_authority") &&
    switchTestScript.includes("for expected_role in noosphere_migrator noosphere") &&
    switchTestScript.includes(
      "Digest or backup producer used unexpected authority",
    ),
  "migration signing and logical backup must cover both the preferred migrator and released legacy-owner authority paths",
);

const digestRuntimeStart = digestTestScript.indexOf("trap cleanup EXIT INT TERM");
const digestRuntimeBody =
  digestRuntimeStart >= 0 ? digestTestScript.slice(digestRuntimeStart) : "";
const executableDigestRuntime = digestRuntimeBody
  .split(/\r?\n/)
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");
const executableDigestTest = digestTestScript
  .split(/\r?\n/)
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");
const requiredDigestFailureMessages = [
  "catalog identifier escaped COPY",
  "primary-key identifier escaped ORDER BY",
  "schema identifier escaped qualification",
  "sequence identifier escaped qualification",
  "producer failure returned a successful digest",
  "included primary-key payload was treated as an ORDER BY key",
  "composite primary-key order did not normalize opposite insertion order",
  "composite primary-key inventory omitted or reordered key attributes",
  "large-object data was silently excluded",
  "non-public table mutation was not detected",
  "sequence-state mutation was not detected",
  "empty table collided with a one-row empty-string table",
  "cross-table row placement collided with an unframed table header",
  "unsupported partitioned-table data was silently excluded",
  "unsupported materialized-view data was silently excluded",
  "unsupported foreign-table data was silently excluded",
];
const exactRehearsalMatrix = postgresRehearsalWorkflow.match(
  /    strategy:\n[\s\S]*?    env:/,
)?.[0] ?? "";
const rehearsalPlatforms = Array.from(
  exactRehearsalMatrix.matchAll(
    /^          - platform: ([^\n]+)\n            slug: ([^\n]+)$/gm,
  ),
  ([, platform, slug]) => [platform, slug],
);
expect(
  digestTestScript.includes(
    'DIGEST_HELPER_SCRIPT=${PGVECTOR_DIGEST_FIXTURE_SCRIPT:-"$ROOT_DIR/scripts/switch-pgvector-compose.sh"}',
  ) &&
  digestTestScript.includes("OWNER_LABEL_KEY=io.noosphere.digest-test-owner") &&
    digestTestScript.includes("for helper in digest_role _digest_psql") &&
    digestTestScript.includes("digest_role_definition=$(extract_function digest_role)") &&
    digestTestScript.includes("digest role selection no longer owns candidate and released-v1.11 authority") &&
    digestTestScript.includes("schema digest no longer authenticates through the validated digest role") &&
    !digestTestScript.includes("pg_dump -U noosphere_migrator") &&
    digestTestScript.includes('source_container_created=false') &&
    digestTestScript.includes('[[ "$source_container_created" == false ]] || remove_container') &&
    digestTestScript.includes("expected exactly one digest helper definition") &&
    countLiteral(
      executableDigestTest,
      "record_failure 'duplicate digest helper definitions were accepted'",
    ) === 1 &&
    requiredDigestFailureMessages.every(
      (message) => countLiteral(executableDigestRuntime, message) === 1,
    ) &&
    !anyShellFunctionDeclarationPattern.test(
      normalizeShellLineContinuations(digestRuntimeBody),
    ) &&
    countLiteral(executableDigestRuntime, "((failures == 0))") === 1 &&
    supportedDataObjectsFunction.includes("c.relkind IN ('m', 'f', 'p')") &&
    supportedDataObjectsFunction.includes("pg_catalog.pg_largeobject_metadata") &&
    dataInventoryFunction.includes("key.ordinality <= i.indnkeyatts") &&
    switchTestScript.includes("Explicit $invalid_version data signature version downgraded to legacy v1") &&
    switchTestScript.includes("for invalid_version in false null 0 3 1.5 '\"1\"'; do") &&
    switchTestScript.includes("del(.authorizationVolumeFingerprint, .dataSignatureVersion)") &&
    postgresRehearsalWorkflow.includes(
      'run: scripts/test-digest-order-independence.sh ${{ matrix.platform }}',
    ) &&
    JSON.stringify(rehearsalPlatforms) ===
      JSON.stringify([
        ["linux/amd64", "amd64"],
        ["linux/arm64", "arm64"],
      ]) &&
    postgresRehearsalWorkflow.match(
      /- "scripts\/test-digest-order-independence\.sh"/g,
    )?.length === 2,
  "the PostgreSQL rehearsal must run deterministic digest security, coverage, streaming, and failure regressions on both architectures",
);

const focusedControllerJob = workflowJob(
  postgresRehearsalWorkflow,
  "test-transition-controller",
);
const dockerControllerJob = workflowJob(
  postgresRehearsalWorkflow,
  "rehearse-transition-controller",
);
const installerControllerFixture = read("scripts/test-install-openclaw-transition-controller.sh");
const installerControllerDefinitions = Array.from(
  installerControllerFixture.matchAll(/^(test_[A-Za-z0-9_]+)\(\) \(/gm),
  (match) => match[1],
);
const installerControllerDispatches = Array.from(
  installerControllerFixture.matchAll(/^  (test_[A-Za-z0-9_]+)$/gm),
  (match) => match[1],
);
expect(
  installerControllerDefinitions.length === 14 &&
    installerControllerDispatches.length === 14 &&
    new Set(installerControllerDispatches).size === 14 &&
    JSON.stringify([...installerControllerDefinitions].sort()) ===
      JSON.stringify([...installerControllerDispatches].sort()),
  "the installer transition-controller fixture must define and dispatch exactly fourteen unique owners",
);
const focusedControllerFixture = read("scripts/test-pgvector-transition-controller.sh");
const focusedControllerDefinitions = Array.from(
  focusedControllerFixture.matchAll(/^(test_[A-Za-z0-9_]+)\(\) \(/gm),
  (match) => match[1],
);
const focusedControllerDispatches = Array.from(
  focusedControllerFixture.matchAll(/^  (test_[A-Za-z0-9_]+)$/gm),
  (match) => match[1],
);
const sourceRecoveryStart = switchScript.indexOf("attempt_source_recovery() (");
const sourceRecoveryEnd = switchScript.indexOf("\n)\n\nrecover_source()", sourceRecoveryStart);
const sourceRecovery =
  sourceRecoveryStart >= 0 && sourceRecoveryEnd > sourceRecoveryStart
    ? switchScript.slice(sourceRecoveryStart, sourceRecoveryEnd)
    : "";
expect(
  switchScript.includes("container_running_state()") &&
    switchScript.includes("docker container inspect") &&
    switchScript.includes("docker container ls --all --format '{{.Names}}'") &&
    switchScript.includes('db_state=$(container_running_state "$db_container")') &&
    switchScript.includes("could not classify the database container before the new-install claim") &&
    switchScript.includes("could not classify the prepared new-install database container") &&
    switchScript.includes("could not classify the new-install database during finalization") &&
    !switchScript.includes('docker inspect "$app_container"') &&
    !switchScript.includes(
      'docker container inspect "$app_container" --format \'{{.State.Running}}\'',
    ) &&
    controllerScript.includes("container_running_state()") &&
    controllerScript.includes('finalContainerState == "absent"') &&
    controllerScript.includes('inspectRunning == null') &&
    controllerScript.includes('.stopExitCode | type == "number"') &&
    controllerScript.includes('.stopAttempted == true') &&
    controllerScript.includes('.initialContainerState == "absent"') &&
    sourceRecovery !== "" &&
    countLiteral(sourceRecovery, "stop_app_writer_for_recovery") === 2 &&
    !sourceRecovery.includes('if docker container inspect "$app_container"') &&
    focusedControllerDefinitions.includes(
      "test_absent_app_after_guard_is_authorized_recreated_and_completed",
    ) &&
    focusedControllerDefinitions.includes(
      "test_absent_app_activation_failure_records_truthful_stop_evidence",
    ) &&
    focusedControllerDefinitions.includes(
      "test_writer_stop_evidence_rejects_nonnumeric_stop_exit",
    ),
  "PostgreSQL transition ownership must distinguish exact app-container absence from same-named images, fail closed during source recovery, recreate absent apps through Compose, and bind truthful typed stop evidence",
);
expect(
  focusedControllerDefinitions.length === 140 &&
    focusedControllerDispatches.length === 140 &&
    new Set(focusedControllerDispatches).size === 140 &&
    focusedControllerDefinitions.includes("test_verification_url_accepts_ipv4_loopback_range") &&
    JSON.stringify([...focusedControllerDefinitions].sort()) ===
      JSON.stringify([...focusedControllerDispatches].sort()),
  "the focused transition-controller fixture must define and dispatch exactly 140 unique owners, including absent-app recovery, typed stop evidence, and full IPv4 loopback coverage",
);
const controllerWorkflowTriggerPaths = [
  ".github/workflows/postgres-pgvector-rehearsal.yml",
  "scripts/run-pgvector-transition-controller.sh",
  "scripts/test-install-openclaw-transition-controller.sh",
  "scripts/test-pgvector-transition-controller.sh",
  "scripts/test-pgvector-transition-controller-systemd.sh",
  "scripts/test-pgvector-transition-controller-docker.sh",
  "scripts/switch-pgvector-compose.sh",
  "scripts/verify-deploy.sh",
];
expect(
  controllerWorkflowTriggerPaths.every(
    (relativePath) =>
      countLiteral(postgresRehearsalWorkflow, `- "${relativePath}"`) === 2,
  ) &&
    countLiteral(
      focusedControllerJob,
      "run: scripts/test-pgvector-transition-controller.sh",
    ) === 1 &&
    countLiteral(
      focusedControllerJob,
      "run: scripts/test-install-openclaw-transition-controller.sh",
    ) === 1 &&
    countLiteral(
      dockerControllerJob,
      "run: scripts/test-pgvector-transition-controller-docker.sh linux/amd64",
    ) === 1 &&
    countLiteral(focusedControllerJob, 'sudo loginctl enable-linger "$USER"') === 1 &&
    countLiteral(dockerControllerJob, 'sudo loginctl enable-linger "$USER"') === 1 &&
    countLiteral(
      focusedControllerJob,
      "uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6",
    ) === 1 &&
    countLiteral(
      dockerControllerJob,
      "uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6",
    ) === 1 &&
    countLiteral(
      focusedControllerJob,
      'sudo install -o root -g root -m 0755 "$node_path" /usr/bin/node',
    ) === 1 &&
    countLiteral(
      dockerControllerJob,
      'sudo install -o root -g root -m 0755 "$node_path" /usr/bin/node',
    ) === 1 &&
    countLiteral(focusedControllerJob, "sudo chmod 0755 /usr/local/bin") === 1 &&
    countLiteral(dockerControllerJob, "sudo chmod 0755 /usr/local/bin") === 1 &&
    countLiteral(
      focusedControllerJob,
      "sudo apt-get install --yes --no-install-recommends ripgrep",
    ) === 1 &&
    countLiteral(focusedControllerJob, 'sudo loginctl disable-linger "$USER"') === 1 &&
    countLiteral(dockerControllerJob, 'sudo loginctl disable-linger "$USER"') === 1 &&
    countLiteral(
      dockerControllerJob,
      'docker pull --platform linux/amd64 "$image"',
    ) === 1,
  "the path-filtered PostgreSQL rehearsal workflow must install pinned Node, harden the controller bootstrap PATH, install the focused fixture toolchain, and run the focused and pinned-Docker interruption gates under disposable persistent user managers",
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
  sha256("install-openclaw.sh") === guidedBackendSha256,
  "the checked-in backend bytes must match the checksum pinned by the guided launcher",
);
expect(
  sha256("install.sh") === guidedInstallerSha256,
  "the checked-in guided launcher bytes must match the checksum advertised by public immutable-install guidance",
);

if (verifyRemoteArtifacts) {
  await verifyRemoteArtifact(
    "guided installer",
    `${rawRepositoryUrl}/${guidedInstallerRef}/install.sh`,
    guidedInstallerSha256,
  );
  await verifyRemoteArtifact(
    "guided installer backend",
    `${rawRepositoryUrl}/${guidedBackendRef}/install-openclaw.sh`,
    guidedBackendSha256,
  );
  for (const { label, shaConstant, urlConstant } of helperArtifacts) {
    await verifyRemoteArtifact(
      label,
      extractShellStringConstant(installer, urlConstant),
      extractShellConstant(installer, shaConstant),
    );
  }
}

let releaseAssetExpectations = [];
if (verifyReleaseArtifacts) {
  const expectedReleaseDir = mkdtempSync(join(tmpdir(), "noosphere-release-assets-"));
  try {
    const packageResult = spawnSync(
      "bash",
      [resolve(root, "scripts/package-installer.sh"), expectedReleaseDir],
      { cwd: root, encoding: "utf8", env: { ...process.env } },
    );
    expect(
      packageResult.status === 0,
      `failed to build deterministic release expectations: ${packageResult.stderr || packageResult.stdout}`,
    );
    if (packageResult.status === 0) {
      const hermesName = `hermes-noosphere-memory-${releaseVersion}.tar.gz`;
      const expectedNames = [
        "install.sh",
        "install.sh.sha256",
        "install-openclaw.sh",
        "install-openclaw.sh.sha256",
        hermesName,
        `${hermesName}.sha256`,
      ];
      const expectedReleaseBase =
        `https://github.com/SweetSophia/noosphere/releases/download/v${releaseVersion}/`;
      releaseAssetExpectations = expectedNames.map((filename) => ({
        filename,
        sha256: sha256Bytes(readFileSync(resolve(expectedReleaseDir, filename))),
        url: `${expectedReleaseBase}${filename}`,
      }));
    }
  } finally {
    rmSync(expectedReleaseDir, { recursive: true, force: true });
  }
}
if (verifyReleaseFiles) {
  const releaseLauncherName = "install.sh";
  const releaseBackendName = "install-openclaw.sh";
  const releaseLauncher = readReleaseText(releaseLauncherName);
  const releaseVersion = extractShellStringConstant(releaseLauncher, "RELEASE_VERSION");
  const hermesName = `hermes-noosphere-memory-${releaseVersion}.tar.gz`;
  const expectedNames = [
    releaseLauncherName,
    `${releaseLauncherName}.sha256`,
    releaseBackendName,
    `${releaseBackendName}.sha256`,
    hermesName,
    `${hermesName}.sha256`,
  ].sort();
  try {
    const actualNames = readdirSync(releaseRoot).sort();
    expect(
      JSON.stringify(actualNames) === JSON.stringify(expectedNames),
      `release verification directory must contain exactly: ${expectedNames.join(", ")}`,
    );
  } catch (error) {
    failures.push(`Failed to enumerate release verification directory: ${error.message}`);
  }

  const releaseBackend = readReleaseBytes(releaseBackendName);
  const releaseHermes = readReleaseBytes(hermesName);
  const releaseLauncherBytes = Buffer.from(releaseLauncher, "utf8");
  const releaseLauncherSha = sha256Bytes(releaseLauncherBytes);
  const releaseBackendSha = sha256Bytes(releaseBackend);
  const releaseHermesSha = sha256Bytes(releaseHermes);
  const declaredLauncherSha = expectedChecksum(
    readReleaseText(`${releaseLauncherName}.sha256`),
    releaseLauncherName,
  );
  const declaredBackendSha = expectedChecksum(
    readReleaseText(`${releaseBackendName}.sha256`),
    releaseBackendName,
  );
  const declaredHermesSha = expectedChecksum(
    readReleaseText(`${hermesName}.sha256`),
    hermesName,
  );
  expect(declaredLauncherSha === releaseLauncherSha, "release install.sh checksum must match downloaded bytes");
  expect(declaredBackendSha === releaseBackendSha, "release install-openclaw.sh checksum must match downloaded bytes");
  expect(declaredHermesSha === releaseHermesSha, "release Hermes checksum must match downloaded bytes");
  expect(
    extractShellConstant(releaseLauncher, "BACKEND_SHA256") === releaseBackendSha,
    "release launcher must pin the downloaded backend bytes",
  );
  expect(
    extractShellConstant(releaseLauncher, "HERMES_BUNDLE_SHA256") === releaseHermesSha,
    "release launcher must pin the downloaded Hermes bundle bytes",
  );

  const expectedReleaseBase =
    `https://github.com/SweetSophia/noosphere/releases/download/v${releaseVersion}/`;
  const releaseBackendUrl = extractShellStringConstant(releaseLauncher, "BACKEND_URL");
  const releaseHermesUrl = extractShellStringConstant(releaseLauncher, "HERMES_BUNDLE_URL");
  expect(
    releaseBackendUrl === `${expectedReleaseBase}${releaseBackendName}`,
    "release launcher backend URL must target its coordinated release asset",
  );
  expect(
    releaseHermesUrl === `${expectedReleaseBase}${hermesName}`,
    "release launcher Hermes URL must target its coordinated release asset",
  );
}

if (verifyReleaseArtifacts) {
  for (const asset of releaseAssetExpectations) {
    await verifyRemoteArtifact(
      `published release asset ${asset.filename}`,
      asset.url,
      asset.sha256,
      { followRedirects: true },
    );
  }
}

if (failures.length > 0) {
  console.error("PostgreSQL image policy check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("PostgreSQL image policy check passed.");
