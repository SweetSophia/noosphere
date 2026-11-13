import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const doc = readFileSync(new URL('../docs/HYBRID-RETRIEVAL-ACTIVATION.md', import.meta.url), 'utf8');
const fences = [...doc.matchAll(/```bash\n([\s\S]*?)\n\s*```/g)].map(m => m[1]);
function functions(name) {
  const block = fences.find(b => b.includes(`${name}() {`));
  assert.ok(block, `${name} fenced function missing`);
  return block.slice(0, block.lastIndexOf('\n   ' + (name === 'discover_worker' ? 'discover_worker ||' : name === 'capture_initial_worker_logs' ? 'archive=' : name)));
}
function run(body) {
  const dir = mkdtempSync(join(tmpdir(), 'worker-runbook-'));
  try {
    const script = `set -eu\nexport FIXTURE=${JSON.stringify(dir)}\n` + functions('discover_worker') + '\n' + functions('capture_initial_worker_logs') + '\n' + functions('capture_final_worker_logs') + '\n' + functions('recreate_verified_worker') + `
container=fixture
compose=(docker compose)
worker_ready=yes
archive="$FIXTURE/archive"
docker() {
 case "$1" in
  logs) [ "\${LOG_FAIL:-0}" = 0 ] || return 1
        [ "\${EMPTY:-0}" = 0 ] || return 0
        printf '2026-11-13T12:00:00Z stdout-record\\n'
        printf '2026-11-13T12:00:01Z stderr-record\\n' >&2 ;;
  inspect) if [ "\${2:-}" = --format ]; then
      case "$3" in *working_dir*) printf '%s\\n' "$FIXTURE" ;; *config_files*) echo fixture.yml ;; *) echo fixture ;; esac
    else printf '%s\\n' '[{"Image":"sha256:deployed","Config":{"Image":"fixture:v1","Env":["NOOSPHERE_TEST=preserved"]}}]'; fi ;;
  image) printf '[{"Id":"%s"}]\\n' "\${LOCAL_IMAGE_ID:-sha256:deployed}" ;;
  compose) case " $* " in
      *' config '*) printf '{"services":{"hybrid-worker":{"image":"%s","environment":{"NOOSPHERE_TEST":"preserved"}}}}\\n' "\${MODEL_IMAGE:-fixture:v1}" ;;
      *' up '*) touch "$FIXTURE/recreated" ;;
    esac ;;
  context) [ "\${CONTEXT_FAIL:-0}" = 0 ] || return 1
      echo "\${ENDPOINT:-unix:///fixture.sock}" ;;
  ps) echo fixture ;;
 esac
}
` + body;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('failed endpoint resolution and remote TCP never publish usable discovery state', () => {
  run(`export DOCKER_CONTEXT=fixture
CONTEXT_FAIL=1
if discover_worker; then exit 21; fi
[ -z "\${worker_ready:-}" ] && [ -z "\${container:-}" ]
CONTEXT_FAIL=0 ENDPOINT=tcp://remote:2376
if discover_worker; then exit 22; fi
[ -z "\${worker_ready:-}" ] && [ "\${#compose[@]}" = 0 ]
`);
});
test('discovery preserves application exports and Docker config while pinning local endpoint', () => {
  run(`export DOCKER_CONTEXT=fixture DOCKER_CONFIG="$FIXTURE" NOOSPHERE_TEST=preserved
export COMPOSE_FILE=unexpected.yml
discover_worker
[ "$worker_ready" = yes ] && [ "$DOCKER_HOST" = unix:///fixture.sock ]
[ "$DOCKER_CONFIG" = "$FIXTURE" ] && [ "$NOOSPHERE_TEST" = preserved ]
[ -z "\${COMPOSE_FILE:-}" ]
verify_worker_model
MODEL_IMAGE=unexpected:v2
if verify_worker_model; then exit 23; fi
`);
});
test('initial archive verifies both streams, records hash and rejects empty or failed captures', () => {
  run(`capture_initial_worker_logs
grep -q stdout-record "$archive/worker-before.log"
grep -q stderr-record "$archive/worker-before.log"
[ -s "$archive/worker-before.log.receipt.json" ] && [ "$initial_capture_ready" = yes ]
EMPTY=1
if capture_initial_worker_logs; then exit 24; fi
[ -z "\${initial_capture_ready:-}" ]
EMPTY=0 LOG_FAIL=1
if capture_initial_worker_logs; then exit 25; fi
[ -z "\${initial_capture_ready:-}" ]
`);
});
test('stop/recreation gates reject model drift and missing final archive', () => {
  run(`capture_initial_worker_logs
MODEL_IMAGE=unexpected:v2
if capture_final_worker_logs; then exit 26; fi
[ -z "\${final_capture_ready:-}" ]
if recreate_verified_worker; then exit 27; fi
MODEL_IMAGE=fixture:v1
capture_final_worker_logs
grep -q stderr-record "$archive/final-worker.log"
[ -s "$archive/final-worker.log.sha256" ]
recreate_verified_worker
[ -f "$FIXTURE/recreated" ]
`);
});

test('a locally retargeted image tag cannot pass the retention-only gate', () => {
  run(`capture_initial_worker_logs
LOCAL_IMAGE_ID=sha256:retargeted
if verify_worker_model; then exit 28; fi
if capture_final_worker_logs; then exit 29; fi
[ -z "\${final_capture_ready:-}" ]
LOCAL_IMAGE_ID=sha256:deployed
capture_final_worker_logs
LOCAL_IMAGE_ID=sha256:retargeted
if recreate_verified_worker; then exit 30; fi
[ ! -f "$FIXTURE/recreated" ]
`);
});

test('npm forwards remote-verification arguments to the image policy checker', () => {
  const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
  const dir = mkdtempSync(join(tmpdir(), 'worker-policy-args-'));
  try {
    const marker = join(dir, 'policy-called');
    const script = `node() {
      if [ "$1" = scripts/check-postgres-image-policy.mjs ]; then
        [ "\${2:-}" = --verify-remote ] || return 41
        printf verified > ${JSON.stringify(marker)}
      elif [ "\${*: -1}" = --verify-remote ]; then
        return 42
      fi
    }
    ${scripts['postgres-image:check']} --verify-remote`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(marker, 'utf8'), 'verified');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
