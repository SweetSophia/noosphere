#!/usr/bin/env bash
# Deterministic regression coverage for the order-independent data signature.
#
# The fixture is fully isolated: it creates two networkless PostgreSQL
# containers with identical logical data but intentionally different table and
# row creation order. It then exercises the exact helper functions embedded in
# switch-pgvector-compose.sh and verifies the security, coverage, streaming,
# and failure-propagation boundaries that make the signature trustworthy.

set -Eeuo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DIGEST_HELPER_SCRIPT=${PGVECTOR_DIGEST_FIXTURE_SCRIPT:-"$ROOT_DIR/scripts/switch-pgvector-compose.sh"}
PLATFORM=${1:-${PLATFORM:-linux/amd64}}
SOURCE_IMAGE=${SOURCE_IMAGE:-postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229}
CANDIDATE_IMAGE=${CANDIDATE_IMAGE:-ghcr.io/sweetsophia/noosphere-postgres-pgvector@sha256:12bc9b34226803a04811a3ddd06feac14121c2c7ce369aaddbd778d242751292}
RUN_ID=${RUN_ID:-digest-$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')}
LABEL_KEY=io.noosphere.digest-test
OWNER_LABEL_KEY=io.noosphere.digest-test-owner
OWNER_TOKEN="$RUN_ID-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
SOURCE_CONTAINER="noosphere-digest-source-$RUN_ID"
CANDIDATE_CONTAINER="noosphere-digest-candidate-$RUN_ID"
SOURCE_VOLUME="noosphere_digest_source_${RUN_ID//-/_}"
CANDIDATE_VOLUME="noosphere_digest_candidate_${RUN_ID//-/_}"
MALICIOUS_TABLE='x") TO PROGRAM '\''touch /tmp/noosphere-digest-pwned'\'';--'
MALICIOUS_COLUMN='id") TO PROGRAM '\''touch /tmp/noosphere-digest-pk-pwned'\'';--'
MALICIOUS_SCHEMA='s") TO PROGRAM '\''touch /tmp/noo-digest-schema-pwned'\'';--'
MALICIOUS_SEQUENCE='q") TO PROGRAM '\''touch /tmp/noo-digest-seq-pwned'\'';--'
DATA_SIGNATURE_VERSION=2
failures=0
source_container_created=false
candidate_container_created=false
source_volume_created=false
candidate_volume_created=false

record_failure() {
  printf 'FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}

die() {
  printf 'digest helper failed: %s\n' "$*" >&2
  exit 1
}

extract_function() {
  local name=$1 source=${2:-"$DIGEST_HELPER_SCRIPT"} definition declaration_pattern dynamic_definition_pattern
  [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "invalid digest helper name: $name"
  # Bracket expressions [(] and [)] match literal parentheses in every awk
  # implementation (gawk, mawk, busybox). Backslash escapes like \( are
  # interpreted inconsistently across awk variants and awk -v escape
  # processing, which made the declaration count diverge between local and
  # CI awk builds.
  declaration_pattern="(^|[^[:alnum:]_])(${name}[[:space:]]*[(][[:space:]]*[)]|function[[:space:]]+${name}([[:space:]]*[(][[:space:]]*[)])?)[[:space:]]*([{]|(#.*)?$)"
  dynamic_definition_pattern='(^|[[:space:];&|(){}])(alias([[:space:]]|$)|shopt[[:space:]]+-s[[:space:]]+expand_aliases([[:space:];&|]|$))'
  if ! definition=$(awk -v signature="${name}() {" -v declaration_pattern="$declaration_pattern" \
    -v dynamic_definition_pattern="$dynamic_definition_pattern" '
    { source = source $0 "\n" }
    $0 == signature {
      capture = 1
    }
    capture { body[++lines] = $0 }
    capture && $0 == "}" { capture = 0 }
    END {
      normalized = source
      gsub(/\\\n/, "", normalized)
      if (normalized ~ dynamic_definition_pattern) exit 1
      logical_line_count = split(normalized, logical_lines, "\n")
      for (line = 1; line <= logical_line_count; line++) {
        if (logical_lines[line] ~ declaration_pattern) matches++
      }
      if (matches != 1) exit 1
      for (line = 1; line <= lines; line++) print body[line]
    }
  ' "$source"); then
    die "expected exactly one digest helper definition: $name"
  fi
  printf '%s\n' "$definition"
}

duplicate_definition_probes=(
  $'probe() {\n  printf safe\n}\nprobe() {\n  printf unsafe\n}\n'
  $'probe() {\n  printf safe\n}\nfunction probe() {\n  printf unsafe\n}\n'
  $'probe() {\n  printf safe\n}\nfunction probe {\n  printf unsafe\n}\n'
  $'probe() {\n  printf safe\n}\nprobe () {\n  printf unsafe\n}\n'
  $'probe() {\n  printf safe\n}\nfunction probe()\n{\n  printf unsafe\n}\n'
  $'probe() {\n  printf safe\n}\ntrue; probe() { printf unsafe; }\n'
  $'probe() {\n  printf safe\n}\nif true; then function probe { printf unsafe; }; fi\n'
  $'probe() {\n  printf safe\n}\npro\\\nbe() { printf unsafe; }\n'
  $'probe() {\n  printf safe\n}\nprobe\\\n() { printf unsafe; }\n'
  $'probe() {\n  printf safe\n}\nprobe() \\\n{ printf unsafe; }\n'
  $'probe() {\n  printf safe\n}\nshopt -s expand_aliases\nalias redefine=\'pro\'\'be() { printf unsafe; }\'\nredefine\n'
)
for probe_source in "${duplicate_definition_probes[@]}"; do
  bash -n <(printf '%s' "$probe_source") || die 'invalid duplicate-definition regression fixture'
  if (extract_function probe <(printf '%s' "$probe_source")) >/dev/null 2>&1; then
    record_failure 'duplicate digest helper definitions were accepted'
  fi
done

bash -n "$DIGEST_HELPER_SCRIPT" || die 'digest helper script is not valid Bash'

for helper in _digest_psql _digest_object_signature _assert_supported_data_objects _collect_data_inventory _decode_base64 \
  normalized_dump legacy_normalized_dump data_signature legacy_data_signature data_signature_for_version; do
  definition=$(extract_function "$helper")
  [[ -n "$definition" ]] || {
    printf 'Missing digest helper in switch script: %s\n' "$helper" >&2
    exit 1
  }
  eval "$definition"
done

digest_psql_definition=$(extract_function _digest_psql)
digest_object_signature_definition=$(extract_function _digest_object_signature)
normalized_dump_definition=$(extract_function normalized_dump)
legacy_dump_definition=$(extract_function legacy_normalized_dump)
[[ "$digest_psql_definition" == *'-U noosphere_migrator '* ]] ||
  record_failure 'digest SQL still authenticates as the bootstrap superuser'
[[ "$normalized_dump_definition" != *'SET ROLE pg_read_all_data'* ]] ||
  record_failure 'v2 digest still depends on bootstrap SET ROLE authority'
[[ "$normalized_dump_definition" == *'pg_dump -U noosphere_migrator '* ]] ||
  record_failure 'schema digest still authenticates as the bootstrap superuser'
[[ "$legacy_dump_definition" == *'pg_dump -U noosphere_migrator '* ]] ||
  record_failure 'legacy digest still authenticates as the bootstrap superuser'
[[ "$digest_object_signature_definition" == *'_digest_psql "$container" "$query" | sha256sum | awk'* ]] ||
  record_failure 'data-object signature no longer streams directly into SHA-256'
[[ "$normalized_dump_definition" != *'=$(_digest_psql'* ]] ||
  record_failure 'normalized dump buffers a complete data-object payload in memory'

resource_label() {
  docker inspect "$1" --format "{{index .Config.Labels \"$LABEL_KEY\"}}" 2>/dev/null || true
}

remove_container() {
  local container=$1
  docker inspect "$container" >/dev/null 2>&1 || return 0
  [[ $(resource_label "$container") == "$RUN_ID" &&
    $(docker inspect "$container" --format "{{index .Config.Labels \"$OWNER_LABEL_KEY\"}}") == "$OWNER_TOKEN" ]] || {
    printf 'Refusing to remove container not created by this test invocation: %s\n' "$container" >&2
    return 1
  }
  docker rm -fv "$container" >/dev/null
}

remove_volume() {
  local test_volume=$1
  docker volume inspect "$test_volume" >/dev/null 2>&1 || return 0
  [[ $(docker volume inspect "$test_volume" --format "{{index .Labels \"$LABEL_KEY\"}}") == "$RUN_ID" &&
    $(docker volume inspect "$test_volume" --format "{{index .Labels \"$OWNER_LABEL_KEY\"}}") == "$OWNER_TOKEN" ]] || {
    printf 'Refusing to remove volume not created by this test invocation: %s\n' "$test_volume" >&2
    return 1
  }
  [[ -z $(docker ps -aq --no-trunc --filter "volume=$test_volume") ]] || {
    printf 'Refusing to remove test volume with a live consumer: %s\n' "$test_volume" >&2
    return 1
  }
  docker volume rm "$test_volume" >/dev/null
}

database_ready() {
  local container=$1
  [[ $(docker exec "$container" cat /proc/1/comm 2>/dev/null || true) == postgres ]] &&
    [[ $(docker exec "$container" psql -XAtq -v ON_ERROR_STOP=1 -U noosphere -d noosphere \
      -c 'SELECT 1;' 2>/dev/null || true) == 1 ]]
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  [[ "$source_container_created" == false ]] || remove_container "$SOURCE_CONTAINER" || status=1
  [[ "$candidate_container_created" == false ]] || remove_container "$CANDIDATE_CONTAINER" || status=1
  [[ "$source_volume_created" == false ]] || remove_volume "$SOURCE_VOLUME" || status=1
  [[ "$candidate_volume_created" == false ]] || remove_volume "$CANDIDATE_VOLUME" || status=1
  exit "$status"
}

for container in "$SOURCE_CONTAINER" "$CANDIDATE_CONTAINER"; do
  docker inspect "$container" >/dev/null 2>&1 && {
    printf 'Digest test container already exists: %s\n' "$container" >&2
    exit 1
  }
done
for test_volume in "$SOURCE_VOLUME" "$CANDIDATE_VOLUME"; do
  docker volume inspect "$test_volume" >/dev/null 2>&1 && {
    printf 'Digest test volume already exists: %s\n' "$test_volume" >&2
    exit 1
  }
done

trap cleanup EXIT INT TERM

docker volume create --driver local --label "$LABEL_KEY=$RUN_ID" --label "$OWNER_LABEL_KEY=$OWNER_TOKEN" "$SOURCE_VOLUME" >/dev/null
[[ $(docker volume inspect "$SOURCE_VOLUME" --format "{{index .Labels \"$OWNER_LABEL_KEY\"}}") == "$OWNER_TOKEN" ]] ||
  die "source volume creation collided with another invocation: $SOURCE_VOLUME"
source_volume_created=true
docker volume create --driver local --label "$LABEL_KEY=$RUN_ID" --label "$OWNER_LABEL_KEY=$OWNER_TOKEN" "$CANDIDATE_VOLUME" >/dev/null
[[ $(docker volume inspect "$CANDIDATE_VOLUME" --format "{{index .Labels \"$OWNER_LABEL_KEY\"}}") == "$OWNER_TOKEN" ]] ||
  die "candidate volume creation collided with another invocation: $CANDIDATE_VOLUME"
candidate_volume_created=true

docker create --name "$SOURCE_CONTAINER" --label "$LABEL_KEY=$RUN_ID" --label "$OWNER_LABEL_KEY=$OWNER_TOKEN" --platform "$PLATFORM" --network none \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_USER=noosphere -e POSTGRES_DB=noosphere \
  -v "$SOURCE_VOLUME:/var/lib/postgresql/data" "$SOURCE_IMAGE" >/dev/null
source_container_created=true
docker start "$SOURCE_CONTAINER" >/dev/null
docker create --name "$CANDIDATE_CONTAINER" --label "$LABEL_KEY=$RUN_ID" --label "$OWNER_LABEL_KEY=$OWNER_TOKEN" --platform "$PLATFORM" --network none \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_USER=noosphere -e POSTGRES_DB=noosphere \
  -v "$CANDIDATE_VOLUME:/var/lib/postgresql/data" "$CANDIDATE_IMAGE" >/dev/null
candidate_container_created=true
docker start "$CANDIDATE_CONTAINER" >/dev/null

for container in "$SOURCE_CONTAINER" "$CANDIDATE_CONTAINER"; do
  for _ in $(seq 1 120); do
    database_ready "$container" && break
    [[ $(docker inspect "$container" --format '{{.State.Running}}') == true ]] || {
      docker logs "$container" >&2
      exit 1
    }
    sleep 1
  done
  database_ready "$container" || {
    docker logs "$container" >&2
    printf 'Digest test database did not become ready: %s\n' "$container" >&2
    exit 1
  }
done

docker exec -i "$SOURCE_CONTAINER" psql -Xq -v ON_ERROR_STOP=1 -U noosphere -d noosphere \
  -v malicious_name="$MALICIOUS_TABLE" -v malicious_column="$MALICIOUS_COLUMN" \
  -v malicious_schema="$MALICIOUS_SCHEMA" -v malicious_sequence="$MALICIOUS_SEQUENCE" <<'SQL'
CREATE ROLE noosphere_migrator LOGIN NOSUPERUSER;
ALTER DATABASE noosphere OWNER TO noosphere_migrator;
ALTER SCHEMA public OWNER TO noosphere_migrator;
SET ROLE noosphere_migrator;
CREATE SCHEMA extra AUTHORIZATION noosphere_migrator;
SELECT pg_catalog.format('CREATE SCHEMA %I AUTHORIZATION noosphere_migrator', :'malicious_schema') \gexec
CREATE TABLE public.x (id text PRIMARY KEY);
CREATE TABLE public."Alpha" (id integer PRIMARY KEY, value text NOT NULL);
CREATE TABLE public."Beta" (id integer PRIMARY KEY, value text NOT NULL);
CREATE TABLE public."Blank" (id text PRIMARY KEY);
CREATE TABLE extra."Secret" (id integer PRIMARY KEY, value text NOT NULL);
CREATE TABLE extra."CompositeOrder" (second integer, first integer, value text NOT NULL, PRIMARY KEY (first, second));
CREATE SEQUENCE extra."Counter";
SELECT pg_catalog.format('CREATE SEQUENCE extra.%I', :'malicious_sequence') \gexec
SELECT pg_catalog.format('CREATE TABLE %I."SchemaPayload" (id text PRIMARY KEY)', :'malicious_schema') \gexec
SELECT pg_catalog.format('CREATE TABLE public.%I (id text PRIMARY KEY)', :'malicious_name') \gexec
SELECT pg_catalog.format('CREATE TABLE public."PkIdentifier" (%I text PRIMARY KEY)', :'malicious_column') \gexec
INSERT INTO public.x VALUES ('safe-source');
INSERT INTO public."Alpha" VALUES (1, 'one'), (2, 'two');
INSERT INTO public."Beta" VALUES (10, 'ten');
INSERT INTO public."Blank" VALUES ('');
INSERT INTO extra."Secret" VALUES (1, 'classified');
INSERT INTO extra."CompositeOrder" VALUES (2, 1, 'two'), (1, 1, 'one');
SELECT pg_catalog.setval('extra."Counter"', 7, true) \gset
SELECT pg_catalog.format('INSERT INTO %I."SchemaPayload" VALUES (%L)', :'malicious_schema', 'schema-payload') \gexec
SELECT pg_catalog.format('INSERT INTO public.%I VALUES (%L)', :'malicious_name', 'payload') \gexec
SELECT pg_catalog.format('INSERT INTO public."PkIdentifier" VALUES (%L)', 'pk-payload') \gexec
RESET ROLE;
SQL

docker exec -i "$CANDIDATE_CONTAINER" psql -Xq -v ON_ERROR_STOP=1 -U noosphere -d noosphere \
  -v malicious_name="$MALICIOUS_TABLE" -v malicious_column="$MALICIOUS_COLUMN" \
  -v malicious_schema="$MALICIOUS_SCHEMA" -v malicious_sequence="$MALICIOUS_SEQUENCE" <<'SQL'
CREATE ROLE noosphere_migrator LOGIN NOSUPERUSER;
ALTER DATABASE noosphere OWNER TO noosphere_migrator;
ALTER SCHEMA public OWNER TO noosphere_migrator;
SET ROLE noosphere_migrator;
CREATE SCHEMA extra AUTHORIZATION noosphere_migrator;
SELECT pg_catalog.format('CREATE SCHEMA %I AUTHORIZATION noosphere_migrator', :'malicious_schema') \gexec
CREATE TABLE extra."Secret" (id integer PRIMARY KEY, value text NOT NULL);
CREATE TABLE extra."CompositeOrder" (second integer, first integer, value text NOT NULL, PRIMARY KEY (first, second));
CREATE SEQUENCE extra."Counter";
SELECT pg_catalog.format('CREATE SEQUENCE extra.%I', :'malicious_sequence') \gexec
SELECT pg_catalog.format('CREATE TABLE %I."SchemaPayload" (id text PRIMARY KEY)', :'malicious_schema') \gexec
CREATE TABLE public."Blank" (id text PRIMARY KEY);
CREATE TABLE public."Beta" (id integer PRIMARY KEY, value text NOT NULL);
CREATE TABLE public."Alpha" (id integer PRIMARY KEY, value text NOT NULL);
CREATE TABLE public.x (id text PRIMARY KEY);
SELECT pg_catalog.format('CREATE TABLE public.%I (id text PRIMARY KEY)', :'malicious_name') \gexec
SELECT pg_catalog.format('CREATE TABLE public."PkIdentifier" (%I text PRIMARY KEY)', :'malicious_column') \gexec
INSERT INTO extra."Secret" VALUES (1, 'classified');
INSERT INTO extra."CompositeOrder" VALUES (1, 1, 'one'), (2, 1, 'two');
SELECT pg_catalog.setval('extra."Counter"', 7, true) \gset
SELECT pg_catalog.format('INSERT INTO %I."SchemaPayload" VALUES (%L)', :'malicious_schema', 'schema-payload') \gexec
INSERT INTO public."Blank" VALUES ('');
INSERT INTO public."Beta" VALUES (10, 'ten');
INSERT INTO public."Alpha" VALUES (2, 'two'), (1, 'one');
INSERT INTO public.x VALUES ('safe-source');
SELECT pg_catalog.format('INSERT INTO public.%I VALUES (%L)', :'malicious_name', 'payload') \gexec
SELECT pg_catalog.format('INSERT INTO public."PkIdentifier" VALUES (%L)', 'pk-payload') \gexec
RESET ROLE;
SQL

source_hash=$(data_signature "$SOURCE_CONTAINER") || record_failure 'source data signature failed'
candidate_hash=$(data_signature "$CANDIDATE_CONTAINER") || record_failure 'candidate data signature failed'
[[ ${source_hash:-missing} == "${candidate_hash:-different}" ]] ||
  record_failure 'composite primary-key order did not normalize opposite insertion order'

composite_order_sql=''
while IFS='|' read -r inventory_kind inventory_schema_b64 inventory_name_b64 _ inventory_order_b64; do
  [[ "$inventory_kind" == table ]] || continue
  [[ $(_decode_base64 "$inventory_schema_b64") == extra ]] || continue
  [[ $(_decode_base64 "$inventory_name_b64") == CompositeOrder ]] || continue
  composite_order_sql=$(_decode_base64 "$inventory_order_b64")
done <<< "$(_collect_data_inventory "$SOURCE_CONTAINER")"
[[ "$composite_order_sql" == 'first, second' ]] ||
  record_failure 'composite primary-key inventory omitted or reordered key attributes'

for container in "$SOURCE_CONTAINER" "$CANDIDATE_CONTAINER"; do
  if docker exec "$container" test -e /tmp/noosphere-digest-pwned; then
    record_failure "catalog identifier escaped COPY and executed a program in $container"
    docker exec "$container" rm -f /tmp/noosphere-digest-pwned
  fi
  if docker exec "$container" test -e /tmp/noosphere-digest-pk-pwned; then
    record_failure "primary-key identifier escaped ORDER BY and executed a program in $container"
    docker exec "$container" rm -f /tmp/noosphere-digest-pk-pwned
  fi
  if docker exec "$container" test -e /tmp/noo-digest-schema-pwned; then
    record_failure "schema identifier escaped qualification and executed a program in $container"
    docker exec "$container" rm -f /tmp/noo-digest-schema-pwned
  fi
  if docker exec "$container" test -e /tmp/noo-digest-seq-pwned; then
    record_failure "sequence identifier escaped qualification and executed a program in $container"
    docker exec "$container" rm -f /tmp/noo-digest-seq-pwned
  fi
done

for container in "$SOURCE_CONTAINER" "$CANDIDATE_CONTAINER"; do
  docker exec "$container" psql -Xq -v ON_ERROR_STOP=1 -U noosphere -d noosphere \
    -c 'SET ROLE noosphere_migrator; CREATE TABLE public."FrameA" (id text PRIMARY KEY); CREATE TABLE public."FrameB" (id text PRIMARY KEY);'
done
frame_b_header='===table:cHVibGlj:RnJhbWVC==='
docker exec "$SOURCE_CONTAINER" psql -Xq -v ON_ERROR_STOP=1 -U noosphere -d noosphere \
  -c "SET ROLE noosphere_migrator; INSERT INTO public.\"FrameB\" VALUES ('$frame_b_header');"
docker exec "$CANDIDATE_CONTAINER" psql -Xq -v ON_ERROR_STOP=1 -U noosphere -d noosphere \
  -c "SET ROLE noosphere_migrator; INSERT INTO public.\"FrameA\" VALUES ('$frame_b_header');"
source_framing_hash=$(data_signature "$SOURCE_CONTAINER") || record_failure 'source framing signature failed'
candidate_framing_hash=$(data_signature "$CANDIDATE_CONTAINER") || record_failure 'candidate framing signature failed'
[[ ${source_framing_hash:-missing} != "${candidate_framing_hash:-missing}" ]] ||
  record_failure 'cross-table row placement collided with an unframed table header'
for container in "$SOURCE_CONTAINER" "$CANDIDATE_CONTAINER"; do
  docker exec "$container" psql -Xq -v ON_ERROR_STOP=1 -U noosphere -d noosphere \
    -c 'DROP TABLE public."FrameA", public."FrameB";'
done

if (data_signature noosphere-digest-container-does-not-exist >/dev/null 2>&1); then
  record_failure 'producer failure returned a successful digest'
fi

docker exec "$CANDIDATE_CONTAINER" psql -Xq -v ON_ERROR_STOP=1 -U noosphere -d noosphere \
  -c 'SET ROLE noosphere_migrator; CREATE TABLE extra."IncludedPayload" (id integer, payload json, PRIMARY KEY (id) INCLUDE (payload));'
if ! (data_signature "$CANDIDATE_CONTAINER" >/dev/null 2>&1); then
  record_failure 'included primary-key payload was treated as an ORDER BY key'
fi
docker exec "$CANDIDATE_CONTAINER" psql -Xq -v ON_ERROR_STOP=1 -U noosphere -d noosphere \
  -c 'DROP TABLE extra."IncludedPayload";'

large_object_oid=$(docker exec -i "$CANDIDATE_CONTAINER" psql -XAtq -v ON_ERROR_STOP=1 -U noosphere -d noosphere <<'SQL'
SET ROLE noosphere_migrator;
SELECT pg_catalog.lo_from_bytea(0, pg_catalog.decode('00', 'hex'));
SQL
)
[[ "$large_object_oid" =~ ^[0-9]+$ ]] || record_failure 'large-object fixture did not create a valid OID'
if (data_signature "$CANDIDATE_CONTAINER" >/dev/null 2>&1); then
  record_failure 'large-object data was silently excluded'
fi
docker exec "$CANDIDATE_CONTAINER" psql -Xq -v ON_ERROR_STOP=1 -U noosphere -d noosphere \
  -c "SELECT pg_catalog.lo_unlink($large_object_oid);" >/dev/null

legacy_source=$(legacy_data_signature "$SOURCE_CONTAINER")
legacy_candidate=$(legacy_data_signature "$CANDIDATE_CONTAINER")
[[ "$legacy_source" != "$legacy_candidate" ]] ||
  record_failure 'fixture did not prove the legacy dump depends on physical row or catalog order'
[[ $(data_signature_for_version "$SOURCE_CONTAINER" 1) == "$legacy_source" ]] ||
  record_failure 'version 1 did not dispatch to the legacy signature algorithm'
[[ $(data_signature_for_version "$SOURCE_CONTAINER" "$DATA_SIGNATURE_VERSION") == "$source_hash" ]] ||
  record_failure 'current signature version did not dispatch to the v2 algorithm'

docker exec "$CANDIDATE_CONTAINER" psql -Xq -v ON_ERROR_STOP=1 -U noosphere -d noosphere \
  -c 'UPDATE extra."Secret" SET value = '\''mutated'\'' WHERE id = 1;'
mutated_hash=$(data_signature "$CANDIDATE_CONTAINER") || record_failure 'non-public mutation signature failed'
[[ "$mutated_hash" != "$source_hash" ]] || record_failure 'non-public table mutation was not detected'
docker exec "$CANDIDATE_CONTAINER" psql -Xq -v ON_ERROR_STOP=1 -U noosphere -d noosphere \
  -c 'UPDATE extra."Secret" SET value = '\''classified'\'' WHERE id = 1;'

docker exec "$CANDIDATE_CONTAINER" psql -Xq -v ON_ERROR_STOP=1 -U noosphere -d noosphere \
  -c 'SELECT pg_catalog.setval('\''extra."Counter"'\'', 8, true);' >/dev/null
mutated_hash=$(data_signature "$CANDIDATE_CONTAINER") || record_failure 'sequence mutation signature failed'
[[ "$mutated_hash" != "$source_hash" ]] || record_failure 'sequence-state mutation was not detected'
docker exec "$CANDIDATE_CONTAINER" psql -Xq -v ON_ERROR_STOP=1 -U noosphere -d noosphere \
  -c 'SELECT pg_catalog.setval('\''extra."Counter"'\'', 7, true);' >/dev/null

docker exec "$CANDIDATE_CONTAINER" psql -Xq -v ON_ERROR_STOP=1 -U noosphere -d noosphere \
  -c 'DELETE FROM public."Blank";'
mutated_hash=$(data_signature "$CANDIDATE_CONTAINER") || record_failure 'blank-row mutation signature failed'
[[ "$mutated_hash" != "$source_hash" ]] || record_failure 'empty table collided with a one-row empty-string table'
docker exec "$CANDIDATE_CONTAINER" psql -Xq -v ON_ERROR_STOP=1 -U noosphere -d noosphere \
  -c 'INSERT INTO public."Blank" VALUES ('\'' '\''::text); UPDATE public."Blank" SET id = '\'''\'';'

docker exec "$CANDIDATE_CONTAINER" psql -Xq -v ON_ERROR_STOP=1 -U noosphere -d noosphere \
  -c 'CREATE TABLE extra."NoPrimaryKey" (value text);'
if (data_signature "$CANDIDATE_CONTAINER" >/dev/null 2>&1); then
  record_failure 'non-public table without a primary key was silently excluded'
fi
docker exec "$CANDIDATE_CONTAINER" psql -Xq -v ON_ERROR_STOP=1 -U noosphere -d noosphere \
  -c 'DROP TABLE extra."NoPrimaryKey";'

docker exec "$CANDIDATE_CONTAINER" psql -Xq -v ON_ERROR_STOP=1 -U noosphere -d noosphere \
  -c 'CREATE TABLE extra."UnsupportedPartitionedData" (id integer) PARTITION BY RANGE (id);'
if (data_signature "$CANDIDATE_CONTAINER" >/dev/null 2>&1); then
  record_failure 'unsupported partitioned-table data was silently excluded'
fi
docker exec "$CANDIDATE_CONTAINER" psql -Xq -v ON_ERROR_STOP=1 -U noosphere -d noosphere \
  -c 'DROP TABLE extra."UnsupportedPartitionedData";'

docker exec "$CANDIDATE_CONTAINER" psql -Xq -v ON_ERROR_STOP=1 -U noosphere -d noosphere \
  -c 'CREATE MATERIALIZED VIEW extra."UnsupportedMaterializedData" AS SELECT 1 AS id;'
if (data_signature "$CANDIDATE_CONTAINER" >/dev/null 2>&1); then
  record_failure 'unsupported materialized-view data was silently excluded'
fi
docker exec "$CANDIDATE_CONTAINER" psql -Xq -v ON_ERROR_STOP=1 -U noosphere -d noosphere \
  -c 'DROP MATERIALIZED VIEW extra."UnsupportedMaterializedData";'

docker exec -i "$CANDIDATE_CONTAINER" psql -Xq -v ON_ERROR_STOP=1 -U noosphere -d noosphere <<'SQL'
CREATE EXTENSION file_fdw;
CREATE SERVER digest_file_server FOREIGN DATA WRAPPER file_fdw;
CREATE FOREIGN TABLE extra."UnsupportedForeignData" (value text)
  SERVER digest_file_server OPTIONS (filename '/etc/hostname', format 'text');
SQL
if (data_signature "$CANDIDATE_CONTAINER" >/dev/null 2>&1); then
  record_failure 'unsupported foreign-table data was silently excluded'
fi

((failures == 0)) || {
  printf 'Order-independent digest boundary test failed: %d assertion(s)\n' "$failures" >&2
  exit 1
}

printf 'Order-independent digest boundary test passed: platform=%s source=%s candidate=%s\n' \
  "$PLATFORM" "$source_hash" "$candidate_hash"
