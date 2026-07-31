#!/usr/bin/env bash
# Focused regression test for the order-independent digest check.
#
# Background: pg_dump --data-only --inserts emits INSERT statements in OID
# order. Production databases whose tables have been incrementally
# created/altered over many migrations accumulate OIDs that drift from
# the "natural" order produced by a fresh pg_restore. This caused the
# production transition to fail at the backup-restored digest check even
# though the underlying data was byte-identical (verified by psql row
# counts).
#
# Fix: normalized_dump now dumps each table via COPY (SELECT ... ORDER BY
# pk_cols) TO STDOUT, iterating tables in sorted name order. This makes
# the digest invariant to OID ordering.
#
# This test reproduces the OID-scrambling scenario and proves the fix:
#   1. Take a logical backup from the production source DB (pg_dump -Fc)
#   2. Restore into the candidate image (offline, no network)
#   3. Compute data_signature for both via normalized_dump
#   4. Assert hashes match despite OID ordering differences

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PLATFORM=${PLATFORM:-linux/amd64}
SOURCE_IMAGE=${SOURCE_IMAGE:-postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229}
CANDIDATE_IMAGE=${CANDIDATE_IMAGE:-ghcr.io/sweetsophia/noosphere-postgres-pgvector@sha256:12bc9b34226803a04811a3ddd06feac14121c2c7ce369aaddbd778d242751292}
RUN_ID=${RUN_ID:-test-digest-$(date +%s)}
TEST_VOLUME="noosphere_digest_test_${RUN_ID//-/_}"
TEST_CONTAINER="noosphere-digest-test-${RUN_ID}"
LABEL_KEY="io.noosphere.digest-test"
BACKUP_FILE=""

cleanup() {
  docker rm -f "$TEST_CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$TEST_VOLUME" >/dev/null 2>&1 || true
  [[ -n "$BACKUP_FILE" ]] && rm -f "$BACKUP_FILE"
}
trap cleanup EXIT INT TERM

# Source only the functions we need (avoid full script setup)
eval "$(awk '/^_collect_tables_pks\(\) \{/,/^\}$/' "$ROOT_DIR/scripts/switch-pgvector-compose.sh")"
eval "$(awk '/^_build_order_clause\(\) \{/,/^\}$/' "$ROOT_DIR/scripts/switch-pgvector-compose.sh")"
eval "$(awk '/^normalized_dump\(\) \{/,/^\}$/' "$ROOT_DIR/scripts/switch-pgvector-compose.sh")"
eval "$(awk '/^data_signature\(\) \{/,/^\}$/' "$ROOT_DIR/scripts/switch-pgvector-compose.sh")"

# Step 1: Take backup from production source DB
echo "[1/5] Taking logical backup from production source DB..."
BACKUP_FILE="/tmp/${RUN_ID}.dump"
docker exec noosphere-db pg_dump -U noosphere -d noosphere -Fc --no-owner --no-privileges > "$BACKUP_FILE"
[[ -s "$BACKUP_FILE" ]] || { echo "Backup is empty" >&2; exit 1; }

# Step 2: Start candidate container
echo "[2/5] Starting candidate container ($PLATFORM)..."
docker volume create --driver local --label "$LABEL_KEY=$RUN_ID" "$TEST_VOLUME" >/dev/null
docker run -d --name "$TEST_CONTAINER" --label "$LABEL_KEY=$RUN_ID" --platform "$PLATFORM" --network none \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_USER=noosphere -e POSTGRES_DB=noosphere \
  -v "$TEST_VOLUME:/var/lib/postgresql/data" "$CANDIDATE_IMAGE" >/dev/null

# Wait for ready
for _ in $(seq 1 30); do
  if docker exec "$TEST_CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 2
done
docker exec "$TEST_CONTAINER" pg_isready -U postgres >/dev/null 2>&1 || { echo "Candidate not ready" >&2; exit 1; }

# Step 3: Restore backup
echo "[3/5] Restoring backup into candidate..."
docker exec -i "$TEST_CONTAINER" pg_restore -U noosphere -d noosphere --clean --if-exists --no-owner --no-privileges < "$BACKUP_FILE" >/dev/null 2>&1

# Step 4: Compute data signatures
echo "[4/5] Computing order-independent data signatures..."
SOURCE_HASH=$(data_signature noosphere-db)
CANDIDATE_HASH=$(data_signature "$TEST_CONTAINER")

# Step 5: Assert match
echo "[5/5] Comparing hashes..."
echo "  Source:     $SOURCE_HASH"
echo "  Candidate:  $CANDIDATE_HASH"
if [[ "$SOURCE_HASH" != "$CANDIDATE_HASH" ]]; then
  echo "✗ FAILED: digest mismatch despite order-independent hashing" >&2
  exit 1
fi

echo "✓ PASSED: order-independent digest matches between source and restored candidate"
TOPICS=$(docker exec noosphere-db psql -U noosphere -d noosphere -tAc 'SELECT count(*) FROM "Topic";')
ARTICLES=$(docker exec noosphere-db psql -U noosphere -d noosphere -tAc 'SELECT count(*) FROM "Article";')
APIKEYS=$(docker exec noosphere-db psql -U noosphere -d noosphere -tAc 'SELECT count(*) FROM "ApiKey";')
echo "  Verified: $TOPICS topics, $ARTICLES articles, $APIKEYS API keys"
