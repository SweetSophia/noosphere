import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);

async function artifact(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

function functionDefinition(sql: string, qualifiedName: string): string {
  const start = sql.indexOf(`CREATE FUNCTION ${qualifiedName}`);
  assert.notEqual(start, -1, `${qualifiedName} definition must remain discoverable`);

  const bodyStart = sql.indexOf("AS $function$", start);
  assert.notEqual(bodyStart, -1, `${qualifiedName} body must use the canonical delimiter`);

  const terminator = "$function$;";
  const end = sql.indexOf(terminator, bodyStart + "AS $function$".length);
  assert.notEqual(end, -1, `${qualifiedName} definition must be complete`);

  return sql.slice(start, end + terminator.length);
}

test("Phase C is independently evidenced and validates exact A3 plus B before activation", async () => {
  const activation = await artifact("docker/hybrid-storage/activate-phase-c.sql");
  const upgradeIndex = activation.indexOf("\\ir upgrade-phase-b-v1-to-v2.sql");
  const validationIndex = activation.indexOf("\\ir validate-phase-b.sql");

  assert.match(activation, /\\ir validate\.sql/);
  assert.match(activation, /\\ir validate-phase-b\.sql/);
  assert.ok(upgradeIndex >= 0, "Phase C must invoke the versioned Phase B upgrader");
  assert.ok(
    upgradeIndex < validationIndex,
    "Phase C must upgrade Phase B before validating the current artifact set",
  );
  assert.match(activation, /noosphere\.phase_c\.source_sha256/);
  assert.match(
    activation,
    /to_regclass\('noosphere_hybrid_b\.feature_state'\) IS NULL[\s\S]*?exact Phase B activation is required before Phase C/,
  );
  assert.match(activation, /refusing partial or attacker-precreated Phase C schema/);
  assert.match(activation, /\\ir validate-phase-c\.sql/);
});

test("Phase B has an exact fail-closed v1 to v2 upgrade contract", async () => {
  const activation = await artifact("docker/hybrid-storage/activate-phase-b.sql");
  const upgrade = await artifact("docker/hybrid-storage/upgrade-phase-b-v1-to-v2.sql");
  const v1Validation = await artifact("docker/hybrid-storage/validate-phase-b-v1.sql");
  const validation = await artifact("docker/hybrid-storage/validate-phase-b.sql");
  const retrievalActivation = await artifact("scripts/activate-hybrid-retrieval.sh");
  const workerActivation = await artifact("scripts/activate-hybrid-worker.sh");
  const worker = await artifact("scripts/hybrid-worker.mjs");

  assert.match(activation, /\\ir upgrade-phase-b-v1-to-v2\.sql/);
  assert.match(upgrade, /5a5cb62c29deceb44b91c0a0252607ce9460b2761dbeca7724963ad7043fca98/);
  assert.match(upgrade, /\\ir validate-phase-b-v1\.sql/);
  assert.match(upgrade, /feature_version = 2/);
  assert.match(upgrade, /serialize_eligibility\(\)/);
  assert.match(
    upgrade,
    /CREATE OR REPLACE FUNCTION noosphere_hybrid_b\.structural_manifest\(\)/,
  );
  assert.match(upgrade, /convert_to\(evidence\.identity, 'UTF8'\)/);
  assert.match(
    upgrade,
    /LOCK TABLE noosphere_hybrid\.embedding_profile IN SHARE MODE/,
  );
  assert.match(upgrade, /refusing to upgrade Phase B beneath an existing Phase C activation/);
  assert.doesNotMatch(
    upgrade,
    /GRANT EXECUTE ON FUNCTION noosphere_hybrid\.create_profile/,
  );
  assert.match(
    v1Validation,
    /e648c4e83359994349c5502bffa9739ac3401df7f00511722d7111fa8e981f98/,
  );
  assert.doesNotMatch(v1Validation, /pg_catalog\.pg_get_functiondef/);
  assert.match(validation, /state\.feature_version <> 2/);
  assert.match(retrievalActivation, /upgrade-phase-b-v1-to-v2\.sql/);
  assert.match(workerActivation, /upgrade-phase-b-v1-to-v2\.sql/);
  assert.match(worker, /row\.feature_version !== 2/);
});

test("partial-state recovery inventories Phase B readiness and live hybrid sessions safely", async () => {
  const runbook = await artifact("docker/hybrid-storage/README.md");

  assert.match(
    runbook,
    /SELECT 'SELECT ''phase_b'' AS phase, \* FROM noosphere_hybrid_b\.worker_readiness\(\);'\r?\nWHERE pg_catalog\.to_regprocedure\('noosphere_hybrid_b\.worker_readiness\(\)'\) IS NOT NULL\r?\n\\gexec/,
  );
  assert.match(runbook, /FROM pg_catalog\.pg_stat_activity/);
  assert.match(runbook, /application_name LIKE 'noosphere-hybrid-%'/);
});

test("Phase B and C routine manifests use stable catalog fields", async () => {
  for (const path of [
    "docker/hybrid-storage/phase-b-routine-manifest.sql",
    "docker/hybrid-storage/phase-c-routine-manifest.sql",
  ]) {
    const manifest = await artifact(path);
    assert.match(manifest, /procedure\.prosrc/);
    assert.match(manifest, /procedure\.provolatile/);
    assert.match(manifest, /procedure\.proisstrict/);
    assert.match(manifest, /procedure\.proparallel/);
    assert.match(manifest, /procedure\.prosecdef/);
    assert.match(manifest, /ORDER BY setting COLLATE "C"/);
    assert.doesNotMatch(manifest, /pg_get_functiondef/);
    assert.doesNotMatch(manifest, /regprocedure::text/);
  }
});

test("Phase B and C structural manifests bind identities to definitions", async () => {
  for (const path of [
    "docker/hybrid-storage/phase-b-schema.sql",
    "docker/hybrid-storage/phase-c-schema.sql",
  ]) {
    const schema = await artifact(path);
    assert.match(schema, /convert_to\(evidence\.identity, 'UTF8'\)/);
    assert.match(schema, /convert_to\(evidence\.definition, 'UTF8'\)/);
    assert.match(schema, /ORDER BY evidence\.identity/);
  }
});

test("Phase B serializes profile creation before Phase C materializes coverage", async () => {
  const phaseBSchema = await artifact("docker/hybrid-storage/phase-b-schema.sql");
  const phaseBActivation = await artifact("docker/hybrid-storage/activate-phase-b.sql");
  const phaseBValidation = await artifact("docker/hybrid-storage/validate-phase-b.sql");
  const profileCli = await artifact("scripts/hybrid-profile.mjs");

  assert.match(phaseBSchema, /CREATE FUNCTION noosphere_hybrid_b\.create_profile/);
  assert.match(
    phaseBSchema,
    /create_profile[\s\S]*?PERFORM noosphere_hybrid_b\.serialize_eligibility\(\)/,
  );
  assert.match(phaseBActivation, /REVOKE EXECUTE ON FUNCTION noosphere_hybrid\.create_profile/);
  assert.match(phaseBActivation, /GRANT EXECUTE ON FUNCTION noosphere_hybrid_b\.create_profile/);
  assert.match(
    phaseBValidation,
    /has_function_privilege\('noosphere_hybrid_admin', 'noosphere_hybrid_b\.create_profile/,
  );
  assert.match(profileCli, /SELECT noosphere_hybrid_b\.create_profile/);
});

test("application receives only content-free Phase C routines and no table access", async () => {
  const activation = await artifact("docker/hybrid-storage/activate-phase-c.sql");
  const validation = await artifact("docker/hybrid-storage/validate-phase-c.sql");
  const activationScript = await artifact("scripts/activate-hybrid-retrieval.sh");

  assert.match(activation, /GRANT USAGE ON SCHEMA noosphere_hybrid_c TO noosphere_app/);
  assert.match(activation, /query_profile_snapshot\(uuid\)/);
  assert.match(activation, /authorize_query_dispatch\(uuid\)/);
  assert.match(activation, /vector_candidates\(uuid, text, text\[\]\)/);
  assert.doesNotMatch(activation, /TO noosphere_app[^;]*noosphere_vector/s);
  assert.match(activation, /current_vector_membership\(uuid, text\[\]\)/);
  assert.doesNotMatch(activation, /GRANT (?:SELECT|INSERT|UPDATE|DELETE) ON/);
  assert.match(validation, /Phase C application role has direct table privileges/);
  assert.match(validation, /Phase C ACLs exceed the exact owner and application allowlist/);
  assert.match(validation, /acl\.is_grantable/);
  assert.match(activationScript, /has_schema_privilege\(current_user,'noosphere_hybrid_c','USAGE'\)/);
  assert.match(activationScript, /authorize_query_dispatch\(uuid\)','EXECUTE'/);
  assert.match(activationScript, /t:t:t:t:t/);
});

test("vector routines fail closed on serving state, dimension, finiteness, and current article state", async () => {
  const schema = await artifact("docker/hybrid-storage/phase-c-schema.sql");
  const candidates = functionDefinition(
    schema,
    "noosphere_hybrid_c.vector_candidates",
  );

  assert.match(candidates, /profile\.state <> 'serving'/);
  assert.match(candidates, /vector_dims\(query_embedding\) <> profile\.dimensions/);
  assert.match(candidates, /vector_is_finite\(query_embedding\)/);
  assert.match(candidates, /profile\.distance_metric = 'cosine'/);
  assert.match(candidates, /vector_norm\(query_embedding\) = 0/);
  assert.match(candidates, /embedding\.revision = state\.revision/);
  assert.match(candidates, /embedding\.content_hash = noosphere_hybrid\.canonical_hash/);
  assert.match(candidates, /profile_article_is_eligible/);
  assert.match(candidates, /OPERATOR\(noosphere_vector\.<=>\)/);
  assert.match(candidates, /OPERATOR\(noosphere_vector\.<->\)/);
  assert.match(candidates, /OPERATOR\(noosphere_vector\.<#>\)/);
  assert.match(candidates, /ORDER BY 2 ASC, article\."updatedAt" DESC, embedding\.article_id ASC/);
  assert.match(candidates, /LIMIT 200/);
  assert.match(candidates, /cardinality\(candidate_article_ids\) > 1000/);
});

test("profile snapshots read exact materialized coverage without scanning the corpus", async () => {
  const activation = await artifact("docker/hybrid-storage/activate-phase-c.sql");
  const schema = await artifact("docker/hybrid-storage/phase-c-schema.sql");
  const snapshotDefinition = functionDefinition(
    schema,
    "noosphere_hybrid_c.query_profile_snapshot",
  );

  assert.match(schema, /CREATE TABLE noosphere_hybrid_c\.profile_coverage_snapshot/);
  assert.match(schema, /CREATE TABLE noosphere_hybrid_c\.profile_coverage_member/);
  assert.match(schema, /CREATE FUNCTION noosphere_hybrid_c\.refresh_profile_article_coverage/);
  assert.match(schema, /CREATE FUNCTION noosphere_hybrid_c\.refresh_article_coverage/);
  assert.match(schema, /CREATE FUNCTION noosphere_hybrid_c\.refresh_profile_coverage/);
  assert.match(schema, /CREATE FUNCTION noosphere_hybrid_c\.refresh_all_profile_coverage/);
  assert.match(schema, /REFERENCING NEW TABLE AS new_coverage_members/);
  assert.match(schema, /REFERENCING OLD TABLE AS old_coverage_members/);
  assert.match(schema, /trigger_record\.tgenabled/);
  assert.match(snapshotDefinition, /profile_coverage_snapshot/);
  assert.doesNotMatch(snapshotDefinition, /query_profile_coverage/);
  assert.doesNotMatch(snapshotDefinition, /public\."Article"/);
  assert.match(activation, /SELECT noosphere_hybrid_b\.serialize_eligibility\(\)/);
  assert.match(activation, /zz_noosphere_hybrid_c_article_coverage/);
  assert.match(activation, /zz_noosphere_hybrid_c_embedding_coverage/);
  assert.match(activation, /zz_noosphere_hybrid_c_profile_coverage/);
  assert.match(activation, /zz_noosphere_hybrid_c_consent_coverage/);
});
