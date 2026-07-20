#!/usr/bin/env bash
set -euo pipefail

root_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
bootstrap_url=${NOOSPHERE_BOOTSTRAP_DATABASE_URL:-}
migration_url=${DATABASE_URL:-}
app_url=${NOOSPHERE_APP_DATABASE_URL:-}
admin_url=${NOOSPHERE_HYBRID_ADMIN_DATABASE_URL:-}
worker_url=${NOOSPHERE_HYBRID_WORKER_DATABASE_URL:-}

die() { printf '%s\n' "$*" >&2; exit 1; }
[[ -n "$bootstrap_url" ]] || die 'NOOSPHERE_BOOTSTRAP_DATABASE_URL is required'
[[ -n "$migration_url" ]] || die 'DATABASE_URL must identify the migration role'
[[ -n "$app_url" ]] || die 'NOOSPHERE_APP_DATABASE_URL is required'
[[ -n "$admin_url" ]] || die 'NOOSPHERE_HYBRID_ADMIN_DATABASE_URL is required'
[[ -n "$worker_url" ]] || die 'NOOSPHERE_HYBRID_WORKER_DATABASE_URL is required'
command -v psql >/dev/null 2>&1 || die 'psql is required'
command -v sha256sum >/dev/null 2>&1 || die 'sha256sum is required'

NOOSPHERE_BOOTSTRAP_DATABASE_URL="$bootstrap_url" \
DATABASE_URL="$migration_url" \
NOOSPHERE_APP_DATABASE_URL="$app_url" \
NOOSPHERE_HYBRID_ADMIN_DATABASE_URL="$admin_url" \
NOOSPHERE_HYBRID_WORKER_DATABASE_URL="$worker_url" \
  node "$root_dir/docker/provision-database-roles.mjs"

artifact_set_sha256() {
  local artifact
  for artifact in "$@"; do
    sha256sum "$artifact" | awk '{print $1}'
  done | sha256sum | awk '{print $1}'
}

a3_source_sha256=$(artifact_set_sha256 \
  "$root_dir/docker/hybrid-storage/activate.sql" \
  "$root_dir/docker/hybrid-storage/feature-schema.sql" \
  "$root_dir/docker/hybrid-storage/validate.sql")
phase_b_source_sha256=$(artifact_set_sha256 \
  "$root_dir/docker/hybrid-storage/phase-b-schema.sql" \
  "$root_dir/docker/hybrid-storage/activate-phase-b.sql" \
  "$root_dir/docker/hybrid-storage/validate-phase-b.sql")
phase_c_source_sha256=$(artifact_set_sha256 \
  "$root_dir/docker/hybrid-storage/phase-c-schema.sql" \
  "$root_dir/docker/hybrid-storage/activate-phase-c.sql" \
  "$root_dir/docker/hybrid-storage/validate-phase-c.sql")

psql "$bootstrap_url" -X -v ON_ERROR_STOP=1 \
  -v a3_source_sha256="$a3_source_sha256" \
  -v phase_b_source_sha256="$phase_b_source_sha256" \
  -v phase_c_source_sha256="$phase_c_source_sha256" \
  -f "$root_dir/docker/hybrid-storage/activate-phase-c.sql"

app_identity=$(psql "$app_url" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT current_user || ':' || pg_has_role(current_user, 'noosphere_app', 'MEMBER')")
[[ "$app_identity" == 'noosphere_app:true' ]] || die 'Phase C application identity verification failed'

app_capability=$(psql "$app_url" -XAtq -F ':' -v ON_ERROR_STOP=1 -c \
  "SELECT
     pg_catalog.has_schema_privilege(current_user,'noosphere_hybrid_c','USAGE'),
     pg_catalog.has_function_privilege(current_user,'noosphere_hybrid_c.query_profile_snapshot(uuid)','EXECUTE'),
     pg_catalog.has_function_privilege(current_user,'noosphere_hybrid_c.authorize_query_dispatch(uuid)','EXECUTE'),
     pg_catalog.has_function_privilege(current_user,'noosphere_hybrid_c.vector_candidates(uuid,text,text[])','EXECUTE'),
     pg_catalog.has_function_privilege(current_user,'noosphere_hybrid_c.current_vector_membership(uuid,text[])','EXECUTE')")
[[ "$app_capability" == 't:t:t:t:t' ]] || die 'Phase C application capability verification failed'

printf 'Noosphere hybrid Phase C retrieval capability is active (source SHA-256 %s).\n' \
  "$phase_c_source_sha256"
