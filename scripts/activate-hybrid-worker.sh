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

phase_b_source_sha256=$(
  for phase_b_artifact in \
    "$root_dir/docker/hybrid-storage/phase-b-schema.sql" \
    "$root_dir/docker/hybrid-storage/activate-phase-b.sql" \
    "$root_dir/docker/hybrid-storage/validate-phase-b.sql"; do
    sha256sum "$phase_b_artifact" | awk '{print $1}'
  done |
    sha256sum | awk '{print $1}'
)
a3_source_sha256=$(
  for a3_artifact in \
    "$root_dir/docker/hybrid-storage/activate.sql" \
    "$root_dir/docker/hybrid-storage/feature-schema.sql" \
    "$root_dir/docker/hybrid-storage/validate.sql"; do
    sha256sum "$a3_artifact" | awk '{print $1}'
  done |
    sha256sum | awk '{print $1}'
)

psql "$bootstrap_url" -X -v ON_ERROR_STOP=1 \
  -v a3_source_sha256="$a3_source_sha256" \
  -v phase_b_source_sha256="$phase_b_source_sha256" \
  -f "$root_dir/docker/hybrid-storage/activate-phase-b.sql"

admin_identity=$(psql "$admin_url" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT current_user || ':' || pg_has_role(current_user, 'noosphere_hybrid_admin', 'MEMBER')")
worker_identity=$(psql "$worker_url" -XAtq -v ON_ERROR_STOP=1 -c \
  "SELECT current_user || ':' || pg_has_role(current_user, 'noosphere_hybrid_worker', 'MEMBER')")
[[ "$admin_identity" == 'noosphere_hybrid_admin_login:true' ]] || die 'Phase B admin identity verification failed'
[[ "$worker_identity" == 'noosphere_hybrid_worker_login:true' ]] || die 'Phase B worker identity verification failed'

printf 'Noosphere hybrid Phase B provider/worker layer is active (source SHA-256 %s).\n' \
  "$phase_b_source_sha256"
