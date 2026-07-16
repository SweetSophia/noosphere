#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
VERIFY_SCRIPT="$SCRIPT_DIR/verify-pgvector-image-index.sh"

docker() {
  case "$*" in
    *" --raw") printf '%s\n' "$FAKE_MANIFEST_JSON" ;;
    *".SBOM"*) printf '%s\n' "$FAKE_SBOM_JSON" ;;
    *".Provenance"*) printf '%s\n' "$FAKE_PROVENANCE_JSON" ;;
    *) printf 'unexpected fake docker invocation: %s\n' "$*" >&2; return 2 ;;
  esac
}
export -f docker

export FAKE_MANIFEST_JSON='{"manifests":[{"platform":{"os":"linux","architecture":"amd64"}},{"platform":{"os":"linux","architecture":"arm64"}},{"platform":{"os":"unknown","architecture":"unknown"}}]}'
export FAKE_SBOM_JSON='{"linux/amd64":{"SPDX":{"SPDXID":"SPDXRef-DOCUMENT","spdxVersion":"SPDX-2.3","packages":[{"name":"postgres"}]}},"linux/arm64":{"SPDX":{"SPDXID":"SPDXRef-DOCUMENT","spdxVersion":"SPDX-2.3","packages":[{"name":"postgres"}]}}}'
export FAKE_PROVENANCE_JSON='{"linux/amd64":{"SLSA":{"buildType":"https://mobyproject.org/buildkit@v1","builder":{"id":""},"materials":[{"uri":"source","digest":{"sha256":"aaaa"}}]}},"linux/arm64":{"SLSA":{"buildType":"https://mobyproject.org/buildkit@v1","builder":{"id":""},"materials":[{"uri":"source","digest":{"sha256":"bbbb"}}]}}}'

run_expect_success() {
  local output
  if ! output=$("$VERIFY_SCRIPT" example.invalid/image:test 2>&1); then
    printf 'expected verifier success, got:\n%s\n' "$output" >&2
    exit 1
  fi
}

run_expect_failure() {
  local expected=$1
  local output
  if output=$("$VERIFY_SCRIPT" example.invalid/image:test 2>&1); then
    printf 'expected verifier failure containing %q, but it succeeded\n' "$expected" >&2
    exit 1
  fi
  if [[ "$output" != *"$expected"* ]]; then
    printf 'expected verifier failure containing %q, got:\n%s\n' "$expected" "$output" >&2
    exit 1
  fi
}

run_expect_success

valid_manifest=$FAKE_MANIFEST_JSON
FAKE_MANIFEST_JSON='{"manifests":[{"platform":{"os":"linux","architecture":"amd64"}},{"platform":{"os":"linux","architecture":"arm64"}},{"platform":{"os":"linux","architecture":"arm","variant":"v7"}}]}'
export FAKE_MANIFEST_JSON
run_expect_failure 'exactly linux/amd64 and linux/arm64'
FAKE_MANIFEST_JSON=$valid_manifest
export FAKE_MANIFEST_JSON

FAKE_MANIFEST_JSON='{"manifests":[{"platform":{"os":"linux","architecture":"amd64"}},{"platform":{"os":"linux","architecture":"arm64"}},{"platform":{"os":"windows","architecture":"amd64"}},{"platform":{"os":"unknown","architecture":"unknown"}}]}'
export FAKE_MANIFEST_JSON
run_expect_failure 'exactly linux/amd64 and linux/arm64'
FAKE_MANIFEST_JSON=$valid_manifest
export FAKE_MANIFEST_JSON

valid_sbom=$FAKE_SBOM_JSON
FAKE_SBOM_JSON='{"linux/amd64":{"SPDX":{}},"linux/arm64":{"SPDX":{}}}'
export FAKE_SBOM_JSON
run_expect_failure 'non-empty SPDX SBOM required'
FAKE_SBOM_JSON='{"linux/amd64":{"SPDX":{"SPDXID":"SPDXRef-DOCUMENT","spdxVersion":"SPDX-2.3","packages":[{}]}},"linux/arm64":{"SPDX":{"SPDXID":"SPDXRef-DOCUMENT","spdxVersion":"SPDX-2.3","packages":[{}]}}}'
export FAKE_SBOM_JSON
run_expect_failure 'non-empty SPDX SBOM required'
FAKE_SBOM_JSON=$valid_sbom
export FAKE_SBOM_JSON

valid_provenance=$FAKE_PROVENANCE_JSON
FAKE_PROVENANCE_JSON='{"linux/amd64":{"SLSA":{}},"linux/arm64":{"SLSA":{}}}'
export FAKE_PROVENANCE_JSON
run_expect_failure 'non-empty SLSA provenance required'
FAKE_PROVENANCE_JSON='{"linux/amd64":{"SLSA":{"buildType":"arbitrary","materials":[{}]}},"linux/arm64":{"SLSA":{"buildType":"arbitrary","materials":[{}]}}}'
export FAKE_PROVENANCE_JSON
run_expect_failure 'non-empty SLSA provenance required'
FAKE_PROVENANCE_JSON='{"linux/amd64":{"SLSA":{"buildType":"https://mobyproject.org/buildkit@v1","materials":[{"uri":"source","digest":{}}]}},"linux/arm64":{"SLSA":{"buildType":"https://mobyproject.org/buildkit@v1","materials":[{"uri":"source","digest":{}}]}}}'
export FAKE_PROVENANCE_JSON
run_expect_failure 'non-empty SLSA provenance required'
FAKE_PROVENANCE_JSON=$valid_provenance
export FAKE_PROVENANCE_JSON

printf 'pgvector image index verifier regression tests passed\n'
