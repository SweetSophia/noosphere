import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);

async function artifact(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

test("Phase C is independently evidenced and validates exact A3 plus B before activation", async () => {
  const activation = await artifact("docker/hybrid-storage/activate-phase-c.sql");
  assert.match(activation, /\\ir validate\.sql/);
  assert.match(activation, /\\ir validate-phase-b\.sql/);
  assert.match(activation, /noosphere\.phase_c\.source_sha256/);
  assert.match(activation, /refusing partial or attacker-precreated Phase C schema/);
  assert.match(activation, /\\ir validate-phase-c\.sql/);
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
  assert.match(schema, /profile\.state <> 'serving'/);
  assert.match(schema, /vector_dims\(query_embedding\) <> profile\.dimensions/);
  assert.match(schema, /vector_is_finite\(query_embedding\)/);
  assert.match(schema, /profile\.distance_metric = 'cosine'/);
  assert.match(schema, /vector_norm\(query_embedding\) = 0/);
  assert.match(schema, /query_profile_coverage/);
  assert.match(schema, /embedding\.revision = state\.revision/);
  assert.match(schema, /embedding\.content_hash = noosphere_hybrid\.canonical_hash/);
  assert.match(schema, /profile_article_is_eligible/);
  assert.match(schema, /OPERATOR\(noosphere_vector\.<=>\)/);
  assert.match(schema, /OPERATOR\(noosphere_vector\.<->\)/);
  assert.match(schema, /OPERATOR\(noosphere_vector\.<#>\)/);
  assert.match(schema, /ORDER BY 2 ASC, article\."updatedAt" DESC, embedding\.article_id ASC/);
  assert.match(schema, /LIMIT 200/);
});
