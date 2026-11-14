import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
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
    const imageConfig = { Env: ['PATH=/usr/bin', 'NODE_VERSION=24'], Entrypoint: ['/entrypoint.sh'], Cmd: ['node', 'app'], User: 'node', WorkingDir: '/app' };
    const worker = { image: 'fixture:v1', environment: { NOOSPHERE_TEST: 'preserved', SKIP_MIGRATION: '1' }, command: ['node', 'worker'], entrypoint: ['/guard.sh', 'marker=$$authorization'], volumes: [{ type: 'volume', source: 'auth', target: '/run/auth', read_only: true }], healthcheck: { test: ['CMD', 'node', 'health'], interval: '30s' } };
    const deployed = { Image: 'sha256:deployed', Config: { ...imageConfig, Image: 'fixture:v1', Env: [...imageConfig.Env, 'NOOSPHERE_TEST=preserved', 'SKIP_MIGRATION=1'], Cmd: worker.command, Entrypoint: ['/guard.sh', 'marker=$authorization'], Healthcheck: { Test: worker.healthcheck.test, Interval: 30000000000 } }, Mounts: [{ Type: 'volume', Name: 'fixture_auth', Destination: '/run/auth', RW: false }] };
    writeFileSync(join(dir, 'deployed.json'), JSON.stringify([deployed]));
    writeFileSync(join(dir, 'image.json'), JSON.stringify([{ Id: 'sha256:deployed', Config: imageConfig }]));
    writeFileSync(join(dir, 'model.json'), JSON.stringify({ services: { 'hybrid-worker': worker }, volumes: { auth: { name: 'fixture_auth' } } }));
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
    else cat "$FIXTURE/deployed.json"; fi ;;
  image) python3 -c 'import json,sys; d=json.load(open(sys.argv[1]));d[0]["Id"]=sys.argv[2];print(json.dumps(d))' "$FIXTURE/image.json" "\${LOCAL_IMAGE_ID:-sha256:deployed}" ;;
  compose) case " $* " in
      *' config '*) python3 -c 'import json,sys; d=json.load(open(sys.argv[1]));d["services"]["hybrid-worker"]["image"]=sys.argv[2];print(json.dumps(d))' "$FIXTURE/model.json" "\${MODEL_IMAGE:-fixture:v1}" ;;
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

for (const field of ['authorization mount', 'SKIP_MIGRATION', 'command', 'entrypoint', 'healthcheck', 'image default environment']) {
  test(`retention-only verification rejects drift of ${field}`, () => {
    const change = {
      'authorization mount': "w['volumes']=[]",
      SKIP_MIGRATION: "del w['environment']['SKIP_MIGRATION']",
      command: "w['command']=['node','wrong']",
      entrypoint: "w['entrypoint']=['/wrong']",
      healthcheck: "w['healthcheck']['interval']='60s'",
      'image default environment': "w['environment']['NODE_VERSION']='different'",
    }[field];
    run(`verify_worker_model
python3 - "$FIXTURE/model.json" <<'PY'
import json,sys
p=sys.argv[1];d=json.load(open(p));w=d['services']['hybrid-worker']
${change}
open(p,'w').write(json.dumps(d))
PY
if verify_worker_model; then exit 51; fi
[ ! -f "$FIXTURE/recreated" ]
`);
  });
}

test('destructive recreation rejects a deleted or modified final evidence archive', () => {
  run(`capture_initial_worker_logs
capture_final_worker_logs
rm "$archive/final-worker.log"
if recreate_verified_worker; then exit 52; fi
[ ! -f "$FIXTURE/recreated" ]
capture_final_worker_logs
printf 'tampered\\n' >> "$archive/final-worker.log"
if recreate_verified_worker; then exit 53; fi
[ ! -f "$FIXTURE/recreated" ]
`);
});
