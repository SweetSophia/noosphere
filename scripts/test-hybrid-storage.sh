#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
lock_file="$repo_root/docker/postgres-pgvector/rehearsal.env"
test_label_key=io.noosphere.hybrid-storage-test
run_id="$(date -u +%Y%m%d%H%M%S)-$$"
source_container="noosphere-hybrid-source-$run_id"
candidate_container="noosphere-hybrid-candidate-$run_id"
source_volume="noosphere-hybrid-source-$run_id"
candidate_volume="noosphere-hybrid-candidate-$run_id"

die() {
  printf '[hybrid-storage-test] ERROR: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

for command_name in docker grep node npx psql sed xxd; do
  need "$command_name"
done
[[ -f "$lock_file" ]] || die "missing image lock: $lock_file"
# shellcheck disable=SC1090
source "$lock_file"
[[ "$SOURCE_IMAGE" =~ @sha256:[a-f0-9]{64}$ ]] || die 'SOURCE_IMAGE is not immutable'
[[ "$CANDIDATE_IMAGE" =~ @sha256:[a-f0-9]{64}$ ]] || die 'CANDIDATE_IMAGE is not immutable'

cleanup_container() {
  local name=$1
  local actual_label
  if ! docker container inspect "$name" >/dev/null 2>&1; then
    return
  fi
  actual_label=$(docker container inspect "$name" --format "{{ index .Config.Labels \"$test_label_key\" }}")
  [[ "$actual_label" == "$run_id" ]] || die "refusing cleanup of unowned container $name"
  docker rm -f "$name" >/dev/null
}

cleanup_volume() {
  local name=$1
  local actual_label
  if ! docker volume inspect "$name" >/dev/null 2>&1; then
    return
  fi
  actual_label=$(docker volume inspect "$name" --format "{{ index .Labels \"$test_label_key\" }}")
  [[ "$actual_label" == "$run_id" ]] || die "refusing cleanup of unowned volume $name"
  docker volume rm "$name" >/dev/null
}

cleanup() {
  local status=$?
  cleanup_container "$source_container"
  cleanup_container "$candidate_container"
  cleanup_volume "$source_volume"
  cleanup_volume "$candidate_volume"
  exit "$status"
}
trap cleanup EXIT INT TERM

for name in "$source_container" "$candidate_container"; do
  ! docker container inspect "$name" >/dev/null 2>&1 || die "container already exists: $name"
done
for name in "$source_volume" "$candidate_volume"; do
  ! docker volume inspect "$name" >/dev/null 2>&1 || die "volume already exists: $name"
  docker volume create --label "$test_label_key=$run_id" "$name" >/dev/null
done

start_database() {
  local name=$1
  local volume=$2
  local image=$3
  local password=$4
  docker run -d \
    --name "$name" \
    --label "$test_label_key=$run_id" \
    -e POSTGRES_USER=noosphere_bootstrap \
    -e POSTGRES_PASSWORD="$password" \
    -e POSTGRES_DB=noosphere \
    -p 127.0.0.1::5432 \
    -v "$volume:/var/lib/postgresql/data" \
    "$image" >/dev/null
}

wait_database() {
  local name=$1
  local password=$2
  local attempt
  for attempt in $(seq 1 90); do
    if [[ "$(docker inspect "$name" --format '{{.State.Status}}' 2>/dev/null || true)" == running ]] \
      && [[ "$(docker exec "$name" sh -c 'cat /proc/1/comm' 2>/dev/null || true)" == postgres ]] \
      && docker exec -e PGPASSWORD="$password" "$name" \
        psql -XAtq -U noosphere_bootstrap -d noosphere -c 'SELECT 1' 2>/dev/null | grep -qx 1; then
      return
    fi
    sleep 1
  done
  docker logs "$name" >&2 || true
  die "database did not become ready: $name"
}

database_port() {
  docker port "$1" 5432/tcp | sed -n 's/.*://p'
}

expect_sql_failure() {
  local label=$1
  local url=$2
  local statement=$3
  if psql "$url" -XAtq -v ON_ERROR_STOP=1 -c "$statement" >/dev/null 2>&1; then
    die "$label unexpectedly succeeded"
  fi
}

assert_equals() {
  local expected=$1
  local actual=$2
  local label=$3
  [[ "$actual" == "$expected" ]] || die "$label: expected '$expected', got '$actual'"
}

activate_candidate() {
  NOOSPHERE_BOOTSTRAP_DATABASE_URL="$candidate_bootstrap" \
  DATABASE_URL="$candidate_migrator" \
  NOOSPHERE_APP_DATABASE_URL="$candidate_app" \
  NOOSPHERE_HYBRID_ADMIN_DATABASE_URL="$candidate_admin" \
  NOOSPHERE_HYBRID_WORKER_DATABASE_URL="$candidate_worker" \
  NOOSPHERE_DB_CONTAINER="$candidate_container" \
    "$repo_root/scripts/activate-hybrid-storage.sh"
}

expect_activation_failure() {
  local label=$1
  if activate_candidate >/dev/null 2>&1; then
    die "$label unexpectedly passed exact repeat activation"
  fi
}

start_database "$source_container" "$source_volume" "$SOURCE_IMAGE" source-bootstrap-password
start_database "$candidate_container" "$candidate_volume" "$CANDIDATE_IMAGE" candidate-bootstrap-password
wait_database "$source_container" source-bootstrap-password
wait_database "$candidate_container" candidate-bootstrap-password

source_port=$(database_port "$source_container")
candidate_port=$(database_port "$candidate_container")
[[ -n "$source_port" && -n "$candidate_port" ]] || die 'failed to resolve database ports'

source_bootstrap="postgresql://noosphere_bootstrap:source-bootstrap-password@127.0.0.1:$source_port/noosphere"
source_migrator="postgresql://noosphere_migrator:source-migrator-password@127.0.0.1:$source_port/noosphere"
source_app="postgresql://noosphere_app:source-app-password@127.0.0.1:$source_port/noosphere"
source_shadow="postgresql://noosphere_migrator:source-migrator-password@127.0.0.1:$source_port/noosphere_shadow"
candidate_bootstrap="postgresql://noosphere_bootstrap:candidate-bootstrap-password@127.0.0.1:$candidate_port/noosphere"
candidate_migrator="postgresql://noosphere_migrator:candidate-migrator-password@127.0.0.1:$candidate_port/noosphere"
candidate_app="postgresql://noosphere_app:candidate-app-password@127.0.0.1:$candidate_port/noosphere"
candidate_admin="postgresql://noosphere_hybrid_admin_login:candidate-admin-password@127.0.0.1:$candidate_port/noosphere"
candidate_worker="postgresql://noosphere_hybrid_worker_login:candidate-worker-password@127.0.0.1:$candidate_port/noosphere"
candidate_shadow="postgresql://noosphere_migrator:candidate-migrator-password@127.0.0.1:$candidate_port/noosphere_shadow"

if NOOSPHERE_BOOTSTRAP_DATABASE_URL="$source_bootstrap" \
  DATABASE_URL="$source_migrator" \
  NOOSPHERE_APP_DATABASE_URL="postgresql://noosphere_app:source-bootstrap-password@127.0.0.1:$source_port/noosphere" \
  node "$repo_root/docker/provision-database-roles.mjs" >/dev/null 2>&1; then
  die 'bootstrap/application password reuse unexpectedly passed provisioning'
fi

NOOSPHERE_BOOTSTRAP_DATABASE_URL="$source_bootstrap" \
DATABASE_URL="$source_migrator" \
NOOSPHERE_APP_DATABASE_URL="$source_app" \
  node "$repo_root/docker/provision-database-roles.mjs"

NOOSPHERE_BOOTSTRAP_DATABASE_URL="$candidate_bootstrap" \
DATABASE_URL="$candidate_migrator" \
NOOSPHERE_APP_DATABASE_URL="$candidate_app" \
NOOSPHERE_HYBRID_ADMIN_DATABASE_URL="$candidate_admin" \
NOOSPHERE_HYBRID_WORKER_DATABASE_URL="$candidate_worker" \
  node "$repo_root/docker/provision-database-roles.mjs"

DATABASE_URL="$source_migrator" npx prisma migrate deploy
DATABASE_URL="$candidate_migrator" npx prisma migrate deploy
NOOSPHERE_BOOTSTRAP_DATABASE_URL="$source_bootstrap" \
DATABASE_URL="$source_migrator" \
NOOSPHERE_APP_DATABASE_URL="$source_app" \
  node "$repo_root/docker/provision-database-roles.mjs"
NOOSPHERE_BOOTSTRAP_DATABASE_URL="$candidate_bootstrap" \
DATABASE_URL="$candidate_migrator" \
NOOSPHERE_APP_DATABASE_URL="$candidate_app" \
NOOSPHERE_HYBRID_ADMIN_DATABASE_URL="$candidate_admin" \
NOOSPHERE_HYBRID_WORKER_DATABASE_URL="$candidate_worker" \
  node "$repo_root/docker/provision-database-roles.mjs"
psql "$source_bootstrap" -XAtq -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE noosphere_shadow OWNER noosphere_migrator'
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE noosphere_shadow OWNER noosphere_migrator'

# Extension-less matrix: every Prisma command must leave optional storage absent.
DATABASE_URL="$source_migrator" SHADOW_DATABASE_URL="$source_shadow" npx prisma migrate deploy
DATABASE_URL="$source_migrator" SHADOW_DATABASE_URL="$source_shadow" npx prisma db push
DATABASE_URL="$source_migrator" SHADOW_DATABASE_URL="$source_shadow" \
  npx prisma migrate diff \
    --from-migrations prisma/migrations \
    --to-config-datasource \
    --exit-code
source_feature_count=$(psql "$source_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspname IN ('noosphere_vector','noosphere_crypto','noosphere_hybrid')")
source_extension_count=$(psql "$source_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM pg_catalog.pg_extension WHERE extname IN ('vector','pgcrypto')")
assert_equals 0 "$source_feature_count" 'extension-less Prisma matrix created a feature schema'
assert_equals 0 "$source_extension_count" 'extension-less Prisma matrix installed an optional extension'
expect_sql_failure 'application DDL privilege' "$source_app" 'CREATE TABLE public.application_must_not_create_ddl(id integer)'
expect_sql_failure 'application migration-ledger read' "$source_app" 'SELECT * FROM public._prisma_migrations'
expect_sql_failure 'application migration-ledger mutation' "$source_app" "DELETE FROM public._prisma_migrations WHERE migration_name='never'"

# Activate the candidate fixture, then prove Prisma preserves every optional object.
activate_candidate

before_signature=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT (SELECT oid FROM pg_catalog.pg_extension WHERE extname='vector') || ':' ||
          (SELECT oid FROM pg_catalog.pg_class WHERE oid='noosphere_hybrid.embedding_job'::pg_catalog.regclass) || ':' ||
          (SELECT activation_sql_sha256 FROM noosphere_hybrid.feature_state WHERE singleton)")

DATABASE_URL="$candidate_migrator" SHADOW_DATABASE_URL="$candidate_shadow" npx prisma migrate deploy
DATABASE_URL="$candidate_migrator" SHADOW_DATABASE_URL="$candidate_shadow" npx prisma db push
candidate_diff=$(DATABASE_URL="$candidate_migrator" SHADOW_DATABASE_URL="$candidate_shadow" \
  npx prisma migrate diff \
    --from-migrations prisma/migrations \
    --to-config-datasource \
    --script)
[[ "$candidate_diff" != *'DROP EXTENSION'* && "$candidate_diff" != *'DROP SCHEMA'* ]] ||
  die 'activated migrate diff proposed destructive optional-feature DDL'

activate_candidate
after_signature=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT (SELECT oid FROM pg_catalog.pg_extension WHERE extname='vector') || ':' ||
          (SELECT oid FROM pg_catalog.pg_class WHERE oid='noosphere_hybrid.embedding_job'::pg_catalog.regclass) || ':' ||
          (SELECT activation_sql_sha256 FROM noosphere_hybrid.feature_state WHERE singleton)")
assert_equals "$before_signature" "$after_signature" 'activated Prisma matrix changed optional object identity'

# Repeat activation is validation-only. It must reject direct-login privilege
# drift and trigger semantic drift instead of silently repairing either.
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'GRANT UPDATE, DELETE ON noosphere_hybrid.embedding_job TO noosphere_hybrid_admin_login'
expect_activation_failure 'direct hybrid login grant drift'
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'REVOKE UPDATE, DELETE ON noosphere_hybrid.embedding_job FROM noosphere_hybrid_admin_login'
activate_candidate >/dev/null

psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 <<'SQL'
DROP TRIGGER noosphere_hybrid_article_dirty ON public."Article";
CREATE TRIGGER noosphere_hybrid_article_dirty
AFTER INSERT ON public."Article"
FOR EACH ROW EXECUTE FUNCTION noosphere_hybrid.article_dirty_trigger();
SQL
expect_activation_failure 'hybrid trigger event drift'
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 <<'SQL'
DROP TRIGGER noosphere_hybrid_article_dirty ON public."Article";
CREATE TRIGGER noosphere_hybrid_article_dirty
AFTER INSERT OR UPDATE OF title, excerpt, content, "deletedAt", "recallQuarantinedAt", "restrictedTags"
ON public."Article"
FOR EACH ROW EXECUTE FUNCTION noosphere_hybrid.article_dirty_trigger();
SQL
activate_candidate >/dev/null

psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 <<'SQL'
CREATE OR REPLACE FUNCTION noosphere_hybrid.bump_search_cache_epoch()
RETURNS bigint
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$ SELECT 1::bigint $function$;
SQL
expect_activation_failure 'hybrid routine body drift'
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 <<'SQL'
CREATE OR REPLACE FUNCTION noosphere_hybrid.bump_search_cache_epoch()
RETURNS bigint
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  UPDATE noosphere_hybrid.search_cache_epoch
  SET epoch = epoch + 1
  WHERE singleton
  RETURNING epoch
$function$;
SQL
activate_candidate >/dev/null

psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'GRANT SELECT ON public."Article" TO noosphere_hybrid_admin'
expect_activation_failure 'hybrid administrator public-table grant drift'
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  'REVOKE SELECT ON public."Article" FROM noosphere_hybrid_admin'
activate_candidate >/dev/null

# Effective privileges: each runtime credential receives one bounded capability.
role_audit=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT string_agg(rolname || ':' || rolsuper || ':' || rolcreatedb || ':' || rolcreaterole || ':' || rolbypassrls, ',' ORDER BY rolname)
   FROM pg_catalog.pg_roles
   WHERE rolname IN ('noosphere_app','noosphere_migrator','noosphere_hybrid_admin_login','noosphere_hybrid_worker_login')")
assert_equals 'noosphere_app:false:false:false:false,noosphere_hybrid_admin_login:false:false:false:false,noosphere_hybrid_worker_login:false:false:false:false,noosphere_migrator:false:false:false:false' "$role_audit" 'runtime role attributes'
expect_sql_failure 'worker base Article read' "$candidate_worker" 'SELECT "restrictedTags" FROM public."Article"'
expect_sql_failure 'worker base feature-table read' "$candidate_worker" 'SELECT * FROM noosphere_hybrid.embedding_job'
expect_sql_failure 'administrator supply-evidence mutation' "$candidate_admin" "UPDATE noosphere_hybrid.feature_state SET source_url='tampered'"
expect_sql_failure 'application feature-schema read' "$candidate_app" 'SELECT * FROM noosphere_hybrid.feature_state'

psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO public."Topic" (id, name, slug, "createdAt", "updatedAt")
VALUES ('hybrid-topic', 'Hybrid topic', 'hybrid-topic', clock_timestamp(), clock_timestamp());
INSERT INTO public."Article" (
  id, title, slug, content, excerpt, "topicId", status,
  "createdAt", "updatedAt", "restrictedTags", "memoryRevocationGeneration"
)
VALUES (
  'hybrid-article', 'Café', 'hybrid-article', E'line1\r\nline2', 'Résumé',
  'hybrid-topic', 'published', clock_timestamp(), clock_timestamp(), ARRAY[]::text[], 0
);
SQL

profile_id=$(psql "$candidate_admin" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid.create_profile(
     'openai-compatible','local','fixture-model','fixture-revision',3,
     'cosine','none',1048576,decode(repeat('11',32),'hex'))")
[[ "$profile_id" =~ ^[a-f0-9-]{36}$ ]] || die "invalid profile id: $profile_id"
profile_state=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT state FROM noosphere_hybrid.embedding_profile WHERE id='$profile_id'")
assert_equals inactive "$profile_state" 'new profile lifecycle state'
expect_sql_failure 'premature preparing transition' "$candidate_admin" \
  "SELECT noosphere_hybrid.set_profile_state('$profile_id','preparing')"
expect_sql_failure 'profile identity mutation' "$candidate_bootstrap" \
  "SET ROLE noosphere_hybrid_owner; UPDATE noosphere_hybrid.embedding_profile SET dimensions=4 WHERE id='$profile_id'"
expect_sql_failure 'zero maxInputBytes' "$candidate_admin" \
  "SELECT noosphere_hybrid.create_profile('openai-compatible','local','bad','zero',3,'cosine','none',0,decode(repeat('22',32),'hex'))"
expect_sql_failure 'oversized maxInputBytes' "$candidate_admin" \
  "SELECT noosphere_hybrid.create_profile('openai-compatible','local','bad','large',3,'cosine','none',1048577,decode(repeat('22',32),'hex'))"

canonical_hex=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT encode(noosphere_hybrid.canonical_document('Café','Résumé',E'line1\\r\\nline2',1048576),'hex')")
expected_hex=$(printf 'noosphere-article-v1\nTITLE\nCafé\nEXCERPT\nRésumé\nCONTENT\nline1\nline2\n' | xxd -p -c 1000000)
assert_equals "$expected_hex" "$canonical_hex" 'canonical document bytes'
truncated_hex=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT encode(noosphere_hybrid.truncate_utf8_prefix('A😀B',3),'hex')")
assert_equals 41 "$truncated_hex" 'code-point-safe UTF-8 truncation'

# Phase A3 deliberately keeps preparing/serving unreachable. Set the fixture
# state as the locked owner to exercise the already-installed queue contract.
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SET ROLE noosphere_hybrid_owner; UPDATE noosphere_hybrid.embedding_profile SET state='preparing' WHERE id='$profile_id'" >/dev/null
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET content='revision one', \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article'" >/dev/null

assert_equals 1 "$(psql "$candidate_worker" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM noosphere_hybrid.worker_eligibility WHERE article_id='hybrid-article'")" \
  'worker eligibility view execution'

claim=$(psql "$candidate_worker" -XAtq -F '|' -v ON_ERROR_STOP=1 <<'SQL'
CREATE TEMP TABLE embedding_job(id integer);
CREATE TEMP TABLE embedding_profile(id integer);
CREATE TEMP TABLE worker_eligibility(id integer);
SELECT job_id, lease_token, lease_generation, claimed_revision, encode(claimed_content_hash,'hex')
FROM noosphere_hybrid.claim_jobs(1, 60);
SQL
)
IFS='|' read -r job_id lease_token lease_generation claimed_revision claimed_hash <<<"$claim"
[[ "$job_id" =~ ^[a-f0-9-]{36}$ && "$lease_token" =~ ^[a-f0-9-]{36}$ ]] || die 'worker claim did not return a lease'

psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET content='revision two', \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article';
   UPDATE public.\"Article\" SET content='revision three', \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article'" >/dev/null
stale_publish=$(psql "$candidate_worker" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid.publish_embedding(
     '$job_id','$lease_token',$lease_generation,$claimed_revision,decode('$claimed_hash','hex'),'[1,2,3]'::noosphere_vector.vector)")
assert_equals f "$stale_publish" 'stale completion compare-and-swap result'
queued_after_stale=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT state || ':' || (desired_revision > $claimed_revision) FROM noosphere_hybrid.embedding_job WHERE id='$job_id'")
assert_equals 'queued:true' "$queued_after_stale" 'newer desired revision after stale completion'

claim=$(psql "$candidate_worker" -XAtq -F '|' -v ON_ERROR_STOP=1 -c \
  "SELECT job_id,lease_token,lease_generation,claimed_revision,encode(claimed_content_hash,'hex') FROM noosphere_hybrid.claim_jobs(1,1)")
IFS='|' read -r job_id lease_token lease_generation claimed_revision claimed_hash <<<"$claim"
psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c 'SELECT pg_sleep(1.1)' >/dev/null
expired_publish=$(psql "$candidate_worker" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid.publish_embedding(
     '$job_id','$lease_token',$lease_generation,$claimed_revision,decode('$claimed_hash','hex'),'[1,2,3]'::noosphere_vector.vector)")
assert_equals f "$expired_publish" 'expired lease publication'
expired_claim=$(psql "$candidate_worker" -XAtq -F '|' -v ON_ERROR_STOP=1 -c \
  "SELECT job_id,lease_token,lease_generation,claimed_revision,encode(claimed_content_hash,'hex') FROM noosphere_hybrid.claim_jobs(1,60)")
IFS='|' read -r expired_job expired_token expired_generation expired_revision expired_hash <<<"$expired_claim"
assert_equals "$job_id" "$expired_job" 'lease-expiry reclaim job id'
[[ "$expired_generation" -gt "$lease_generation" ]] || die 'lease generation did not advance on reclaim'
published=$(psql "$candidate_worker" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid.publish_embedding(
     '$expired_job','$expired_token',$expired_generation,$expired_revision,decode('$expired_hash','hex'),'[1,2,3]'::noosphere_vector.vector)")
assert_equals t "$published" 'current embedding publication'
ready=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT dimensions || ':' || revision FROM noosphere_hybrid.article_embedding WHERE article_id='hybrid-article' AND profile_id='$profile_id'")
assert_equals "3:$expired_revision" "$ready" 'ready vector dimensions and revision'

# Privacy quarantine is a stronger eligibility boundary than ordinary scope
# filtering: it cancels a live lease, removes the ready vector, rejects late
# publication, and only requeues after explicit release from quarantine.
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET content='quarantine candidate', \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article'" >/dev/null
claim=$(psql "$candidate_worker" -XAtq -F '|' -v ON_ERROR_STOP=1 -c \
  "SELECT job_id,lease_token,lease_generation,claimed_revision,encode(claimed_content_hash,'hex') FROM noosphere_hybrid.claim_jobs(1,60)")
IFS='|' read -r quarantine_job quarantine_token quarantine_generation quarantine_revision quarantine_hash <<<"$claim"
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET \"recallQuarantinedAt\"=clock_timestamp(), \"recallQuarantineReason\"='hybrid test', \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article'" >/dev/null
assert_equals '0:0' "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c "SELECT (SELECT count(*) FROM noosphere_hybrid.embedding_job WHERE article_id='hybrid-article') || ':' || (SELECT count(*) FROM noosphere_hybrid.article_embedding WHERE article_id='hybrid-article')")" 'privacy quarantine cleanup'
late_quarantine_publish=$(psql "$candidate_worker" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid.publish_embedding(
     '$quarantine_job','$quarantine_token',$quarantine_generation,$quarantine_revision,decode('$quarantine_hash','hex'),'[1,2,3]'::noosphere_vector.vector)")
assert_equals f "$late_quarantine_publish" 'privacy-quarantined late publication'
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET \"recallQuarantinedAt\"=NULL, \"recallQuarantineReason\"=NULL, \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article'" >/dev/null
assert_equals queued "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c "SELECT state FROM noosphere_hybrid.embedding_job WHERE article_id='hybrid-article'")" 'privacy quarantine release queue state'

# Terminal failure must be superseded by a later article revision.
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET content='terminal candidate', \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article'" >/dev/null
claim=$(psql "$candidate_worker" -XAtq -F '|' -v ON_ERROR_STOP=1 -c \
  "SELECT job_id,lease_token,lease_generation FROM noosphere_hybrid.claim_jobs(1,60)")
IFS='|' read -r job_id lease_token lease_generation <<<"$claim"
failed=$(psql "$candidate_worker" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT noosphere_hybrid.fail_job('$job_id','$lease_token',$lease_generation,'provider_timeout',clock_timestamp(),true)")
assert_equals t "$failed" 'terminal failure acknowledgement'
assert_equals failed "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c "SELECT state FROM noosphere_hybrid.embedding_job WHERE id='$job_id'")" 'terminal job state'
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET content='newer after terminal', \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article'" >/dev/null
assert_equals 'queued:0' "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c "SELECT state || ':' || attempt_count FROM noosphere_hybrid.embedding_job WHERE id='$job_id'")" 'new revision after terminal failure'

# Soft-delete cancels a live lease and hard-deletes vectors. Writes while still
# deleted never enqueue; restore creates a new revision; physical delete cascades.
claim=$(psql "$candidate_worker" -XAtq -F '|' -v ON_ERROR_STOP=1 -c \
  "SELECT job_id,lease_token,lease_generation FROM noosphere_hybrid.claim_jobs(1,60)")
IFS='|' read -r job_id lease_token lease_generation <<<"$claim"
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET \"deletedAt\"=clock_timestamp(), \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article'" >/dev/null
assert_equals '0:0' "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c "SELECT (SELECT count(*) FROM noosphere_hybrid.embedding_job WHERE article_id='hybrid-article') || ':' || (SELECT count(*) FROM noosphere_hybrid.article_embedding WHERE article_id='hybrid-article')")" 'soft-delete cleanup'
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET content='changed while deleted', \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article'" >/dev/null
assert_equals 0 "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM noosphere_hybrid.embedding_job WHERE article_id='hybrid-article'")" 'deleted article enqueue count'
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "UPDATE public.\"Article\" SET \"deletedAt\"=NULL, \"updatedAt\"=clock_timestamp() WHERE id='hybrid-article'" >/dev/null
assert_equals queued "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c "SELECT state FROM noosphere_hybrid.embedding_job WHERE article_id='hybrid-article'")" 'restore queue state'

epoch_before=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c 'SELECT epoch FROM noosphere_hybrid.search_cache_epoch WHERE singleton')
psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 <<'SQL'
UPDATE public."Article" SET status='reviewed', "updatedAt"=clock_timestamp() WHERE id='hybrid-article';
INSERT INTO public."Tag" (id,name,slug,"createdAt") VALUES ('hybrid-tag','Hybrid tag','hybrid-tag',clock_timestamp());
INSERT INTO public."ArticleTag" ("articleId","tagId") VALUES ('hybrid-article','hybrid-tag');
UPDATE public."Topic" SET description='changed', "updatedAt"=clock_timestamp() WHERE id='hybrid-topic';
SQL
epoch_after=$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c 'SELECT epoch FROM noosphere_hybrid.search_cache_epoch WHERE singleton')
[[ $((epoch_after - epoch_before)) -ge 4 ]] || die 'cache epoch did not cover Article, Tag, ArticleTag, and Topic mutations'

psql "$candidate_app" -XAtq -v ON_ERROR_STOP=1 -c \
  "DELETE FROM public.\"Article\" WHERE id='hybrid-article'" >/dev/null
assert_equals '0:0:0' "$(psql "$candidate_bootstrap" -XAtq -v ON_ERROR_STOP=1 -c "SELECT (SELECT count(*) FROM noosphere_hybrid.article_embedding_state WHERE article_id='hybrid-article') || ':' || (SELECT count(*) FROM noosphere_hybrid.embedding_job WHERE article_id='hybrid-article') || ':' || (SELECT count(*) FROM noosphere_hybrid.article_embedding WHERE article_id='hybrid-article')")" 'physical-delete cascade'

printf '[hybrid-storage-test] PASS: extension-less and activated drift, privilege, lifecycle, race, deletion, and epoch matrices.\n'
