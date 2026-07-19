#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
metadata="$repo_root/docker/hybrid-storage/metadata.env"
activation_sql="$repo_root/docker/hybrid-storage/activate.sql"
feature_sql="$repo_root/docker/hybrid-storage/feature-schema.sql"
validation_sql="$repo_root/docker/hybrid-storage/validate.sql"

die() {
  printf '[hybrid-storage] ERROR: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

need psql
need sha256sum
need node

[[ -f "$metadata" && -f "$activation_sql" && -f "$feature_sql" && -f "$validation_sql" ]] ||
  die 'activation artifacts are incomplete'

# shellcheck disable=SC1090
source "$metadata"

bootstrap_url=${NOOSPHERE_BOOTSTRAP_DATABASE_URL:-}
app_url=${NOOSPHERE_APP_DATABASE_URL:-}
migration_url=${DATABASE_URL:-}
admin_url=${NOOSPHERE_HYBRID_ADMIN_DATABASE_URL:-}
worker_url=${NOOSPHERE_HYBRID_WORKER_DATABASE_URL:-}
provenance_kind=${NOOSPHERE_HYBRID_PROVENANCE_KIND:-bundled}

[[ -n "$bootstrap_url" ]] || die 'NOOSPHERE_BOOTSTRAP_DATABASE_URL is required'
[[ -n "$app_url" ]] || die 'NOOSPHERE_APP_DATABASE_URL is required'
[[ -n "$migration_url" ]] || die 'DATABASE_URL must identify the migration role'
[[ -n "$admin_url" ]] || die 'NOOSPHERE_HYBRID_ADMIN_DATABASE_URL is required'
[[ -n "$worker_url" ]] || die 'NOOSPHERE_HYBRID_WORKER_DATABASE_URL is required'
[[ "$provenance_kind" == bundled || "$provenance_kind" == external ]] ||
  die 'NOOSPHERE_HYBRID_PROVENANCE_KIND must be bundled or external'

NOOSPHERE_BOOTSTRAP_DATABASE_URL="$bootstrap_url" \
DATABASE_URL="$migration_url" \
NOOSPHERE_APP_DATABASE_URL="$app_url" \
NOOSPHERE_HYBRID_ADMIN_DATABASE_URL="$admin_url" \
NOOSPHERE_HYBRID_WORKER_DATABASE_URL="$worker_url" \
  node "$repo_root/docker/provision-database-roles.mjs"

role_audit=$(
  psql "$bootstrap_url" -XAtq -v ON_ERROR_STOP=1 \
    -v app_url="$app_url" -v migration_url="$migration_url" \
    -v admin_url="$admin_url" -v worker_url="$worker_url" <<'SQL'
WITH supplied(name, url) AS (
  VALUES
    ('app', :'app_url'::text),
    ('migration', :'migration_url'::text),
    ('hybrid-admin', :'admin_url'::text),
    ('hybrid-worker', :'worker_url'::text)
),
parsed AS (
  SELECT
    name,
    (pg_catalog.regexp_match(url, '^[^:]+://([^:/@]+)'))[1] AS role_name
  FROM supplied
),
roles AS (
  SELECT parsed.name, role.*
  FROM parsed
  LEFT JOIN pg_catalog.pg_roles AS role ON role.rolname = parsed.role_name
)
SELECT pg_catalog.string_agg(
  name || ':' || coalesce(rolname, 'missing') || ':' ||
  coalesce(rolsuper::text, 'null') || ':' ||
  coalesce(rolcreatedb::text, 'null') || ':' ||
  coalesce(rolcreaterole::text, 'null') || ':' ||
  coalesce(rolbypassrls::text, 'null'),
  ','
  ORDER BY name
)
FROM roles;
SQL
)
[[ "$role_audit" == 'app:noosphere_app:false:false:false:false,hybrid-admin:noosphere_hybrid_admin_login:false:false:false:false,hybrid-worker:noosphere_hybrid_worker_login:false:false:false:false,migration:noosphere_migrator:false:false:false:false' ]] ||
  die "runtime role separation preflight failed: $role_audit"

server_major=$(psql "$bootstrap_url" -XAtq -v ON_ERROR_STOP=1 -c "SHOW server_version_num")
[[ "$server_major" == 16* ]] || die "PostgreSQL 16 is required, got server_version_num=$server_major"

available_vector=$(
  psql "$bootstrap_url" -XAtq -v ON_ERROR_STOP=1 \
    -c "SELECT default_version FROM pg_catalog.pg_available_extensions WHERE name = 'vector'"
)
[[ "$available_vector" == "$PGVECTOR_VERSION" ]] ||
  die "pgvector $PGVECTOR_VERSION must be available, got ${available_vector:-absent}"
available_crypto=$(
  psql "$bootstrap_url" -XAtq -v ON_ERROR_STOP=1 \
    -c "SELECT count(*) FROM pg_catalog.pg_available_extensions WHERE name = 'pgcrypto'"
)
[[ "$available_crypto" == 1 ]] || die 'pgcrypto must be available'

if [[ "$provenance_kind" == bundled ]]; then
  need docker
  db_container=${NOOSPHERE_DB_CONTAINER:-}
  [[ -n "$db_container" ]] || die 'NOOSPHERE_DB_CONTAINER is required for bundled provenance'
  actual_image=$(docker inspect "$db_container" --format '{{.Image}}') ||
    die "cannot inspect bundled database container $db_container"
  expected_image_id=$(docker image inspect "$BUNDLED_IMAGE_DIGEST" --format '{{.Id}}') ||
    die "cannot inspect locked bundled image $BUNDLED_IMAGE_DIGEST"
  [[ "$actual_image" == "$expected_image_id" ]] ||
    die 'database container does not run the locked bundled image'

  label_pgvector_version=$(docker image inspect "$actual_image" --format '{{ index .Config.Labels "io.noosphere.pgvector.version" }}')
  label_source_url=$(docker image inspect "$actual_image" --format '{{ index .Config.Labels "io.noosphere.pgvector.source.url" }}')
  label_source_sha256=$(docker image inspect "$actual_image" --format '{{ index .Config.Labels "io.noosphere.pgvector.source.sha256" }}')
  label_license=$(docker image inspect "$actual_image" --format '{{ index .Config.Labels "io.noosphere.pgvector.license" }}')
  [[ "$label_pgvector_version" == "$PGVECTOR_VERSION" &&
     "$label_source_url" == "$PGVECTOR_SOURCE_URL" &&
     "$label_source_sha256" == "$PGVECTOR_SOURCE_SHA256" &&
     "$label_license" == "$PGVECTOR_LICENSE_SPDX" ]] ||
    die 'bundled image labels do not match the trusted pgvector metadata lock'

  database_identity=$(
    psql "$bootstrap_url" -XAtq -v ON_ERROR_STOP=1 \
      -c "SELECT current_user || '|' || current_database() || '|' || system_identifier FROM pg_catalog.pg_control_system()"
  )
  IFS='|' read -r bundled_role bundled_database bundled_system_identifier <<< "$database_identity"
  [[ -n "$bundled_role" && -n "$bundled_database" && -n "$bundled_system_identifier" ]] ||
    die 'could not resolve the target PostgreSQL system identity'
  container_system_identifier=$(
    docker exec --user postgres "$db_container" \
      psql -XAtq -v ON_ERROR_STOP=1 -U "$bundled_role" -d "$bundled_database" \
        -c 'SELECT system_identifier FROM pg_catalog.pg_control_system()'
  ) || die 'could not verify the bundled container PostgreSQL system identity'
  [[ "$container_system_identifier" == "$bundled_system_identifier" ]] ||
    die 'NOOSPHERE_DB_CONTAINER is not the PostgreSQL system addressed by the bootstrap URL'
  built_image_digest=$BUNDLED_IMAGE_DIGEST
else
  built_image_digest=${NOOSPHERE_HYBRID_EXTERNAL_IMAGE_DIGEST:-}
  [[ "$built_image_digest" =~ ^external:[a-f0-9]{64}$ ]] ||
    die 'external provenance requires NOOSPHERE_HYBRID_EXTERNAL_IMAGE_DIGEST=external:<sha256>'
fi

public_signature=$(
  psql "$bootstrap_url" -XAtq -v ON_ERROR_STOP=1 <<'SQL'
WITH required(table_name, column_name) AS (
  VALUES
    ('Article', 'id'),
    ('Article', 'title'),
    ('Article', 'excerpt'),
    ('Article', 'content'),
    ('Article', 'deletedAt'),
    ('Article', 'recallQuarantinedAt'),
    ('Article', 'restrictedTags'),
    ('Topic', 'id'),
    ('Tag', 'id'),
    ('ArticleTag', 'articleId'),
    ('ArticleTag', 'tagId')
),
actual AS (
  SELECT
    required.table_name,
    required.column_name,
    pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
    attribute.attnotnull::text AS not_null
  FROM required
  LEFT JOIN pg_catalog.pg_class AS relation
    ON relation.relname = required.table_name
   AND relation.relnamespace = 'public'::pg_catalog.regnamespace
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = relation.oid
   AND attribute.attname = required.column_name
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
)
SELECT pg_catalog.string_agg(
  table_name || '.' || column_name || ':' ||
  coalesce(data_type, 'missing') || ':' ||
  coalesce(not_null, 'missing'),
  E'\n'
  ORDER BY table_name, column_name
)
FROM actual;
SQL
)
[[ "$public_signature" != *missing* ]] ||
  die 'public schema compatibility fingerprint found missing dependencies'
public_schema_fingerprint=$(printf '%s' "$public_signature" | sha256sum | awk '{print $1}')
activation_sql_sha256=$(
  {
    sha256sum "$activation_sql" | awk '{print $1}'
    sha256sum "$feature_sql" | awk '{print $1}'
    sha256sum "$validation_sql" | awk '{print $1}'
  } | sha256sum | awk '{print $1}'
)

psql "$bootstrap_url" -X \
  -v ON_ERROR_STOP=1 \
  -v provenance_kind="$provenance_kind" \
  -v source_url="$PGVECTOR_SOURCE_URL" \
  -v source_sha256="$PGVECTOR_SOURCE_SHA256" \
  -v pgvector_version="$PGVECTOR_VERSION" \
  -v spdx_identifier="$PGVECTOR_LICENSE_SPDX" \
  -v built_image_digest="$built_image_digest" \
  -v activation_sql_sha256="$activation_sql_sha256" \
  -v public_schema_fingerprint="$public_schema_fingerprint" \
  -f "$activation_sql"

printf '[hybrid-storage] Activated feature schema version %s with %s provenance.\n' \
  "$FEATURE_VERSION" "$provenance_kind"
