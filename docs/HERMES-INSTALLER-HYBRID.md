# Work VM: Hermes + installer runtime + llama.cpp hybrid

This is the path for a **fresh machine** (work VM) where Hermes is already
installed and you want Noosphere memory, then hybrid retrieval, without using
the source-development Compose file.

It is **not** a second hybrid ADR. Privilege/SQL contracts stay in
[`docker/hybrid-storage/README.md`](../docker/hybrid-storage/README.md). The
source-compose how-to (host Postgres on `127.0.0.1:5433`) stays in
[`HYBRID-RETRIEVAL-ACTIVATION.md`](HYBRID-RETRIEVAL-ACTIVATION.md). This
document exists because those two do not describe the guided-installer
runtime.

## What you get, in order

1. Guided installer → app at `http://127.0.0.1:6578`, keyword-only recall,
   Hermes plugin with **auto-recall**.
2. Optional: Hermes **turn capture** (drafts), only after a topic exists.
3. llama.cpp `llama-server` on the Docker bridge.
4. Hybrid SQL A/B/C, local profile, worker, then the exact flag `true`.

Hybrid serving and turn capture are **not** one `curl | bash`. The installer
does not enable them.

Do **not** use Ollama. Do **not** clone `docker-compose.yml` from a source
checkout onto the work VM (it still carries owner-host defaults).

## Two runtimes — never mix them

| | Guided installer | Source compose |
| --- | --- | --- |
| Directory | `~/.noosphere` (`$NOOSPHERE_HOME`) | git clone working tree |
| Compose file | `~/.noosphere/docker-compose.yml` (published template) | `docker-compose.yml` |
| Project | `docker compose --project-directory ~/.noosphere` | `docker compose` in the clone |
| App / db containers | `noosphere-openclaw-app` / `noosphere-openclaw-db` | `noosphere-app` / `noosphere-db` |
| Postgres on the host | **not published** | `127.0.0.1:5433` |
| DB URL from scripts | `postgresql://…@db:5432/noosphere` on the compose network | `127.0.0.1:5433` |

`scripts/activate-hybrid-retrieval-stack.sh` targets the source-compose column.
It will look for `noosphere-db` and `127.0.0.1:5433`. Do not run it against
an installer install.

The published image does **not** ship the A/B/C **activator scripts** (only
`hybrid-provider.mjs`, `hybrid-worker.mjs`, `check-hybrid-worker-health.mjs`).
The `docker/hybrid-storage/*.sql` DDL **is** in the image, but the
authoritative SQL + privilege SSOT stays in `docker/hybrid-storage/README.md`
in the repo — keep the shallow scripts checkout for that plus the activator
commands; Compose stays in `~/.noosphere`.

---

## Phase 1 — Noosphere + Hermes

### Prerequisites

Docker Compose v2, Node.js 22+ with `npm`, `git`, `python3`, `pg_restore`,
`curl`, `jq`, `openssl`, `sha256sum`, and `tar`. Hermes CLI on `PATH`. If Hermes
uses a named profile:

```bash
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
```

Defaults bind `127.0.0.1:6578`. Override with `BIND_ADDRESS`, `NOOSPHERE_PORT`,
and `APP_URL` **before** the installer if the wiki must be non-loopback. Do
not copy another host's Tailscale URL.

### Interactive (TTY)

Checksum the launcher, then run it with no flags. It prompts for each agent
CLI it finds (`[Y/n]`, empty enter = Yes):

```bash
(
  set -e
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  curl -fsSL https://raw.githubusercontent.com/SweetSophia/noosphere/5c84a170a5b48754791e57b7e98191df5fbed5b8/install.sh -o "$installer"
  printf '%s  %s\n' '1b98ea75fbcc15d224d4ab188d6f6958380321d98dc412816e3780937473e951' "$installer" | sha256sum -c -
  bash "$installer"
)
```

Say Yes to Hermes. Say No to any other detected CLI you do not want mutated.

### Non-interactive

Same checksum block, last line:

```bash
bash "$installer" --non-interactive --with hermes
```

`--non-interactive` without `--with` or `--core-only` exits 2. No TTY and no
`--with`/`--core-only` also exits 2.

### What the installer did

- Runtime and mode-0600 `.env` in `~/.noosphere`
- Guarded new-install: prepare → db/redis → `init` **once** → record → app
- pgvector image + writer-authorization marker (no existing-volume transition)
- `NOOSPHERE_HYBRID_RETRIEVAL_ENABLED=false`
- Distinct `POSTGRES_*` and `POSTGRES_HYBRID_*` passwords (never printed)
- Admin credentials in `~/.noosphere/credentials.json` (dir 0700, file 0600)
- Scoped Hermes WRITE key in `$HERMES_HOME/.env` as `HERMES_NOOSPHERE_API_KEY`
- Plugin + setup skill under `$HERMES_HOME`; `hermes config set memory.provider noosphere`
- `$HERMES_HOME/noosphere.json` with `auto_recall: true`, `auto_capture: false`

Bootstrap ADMIN key is not written into Hermes config.

### Prove Phase 1

```bash
curl -fsS http://127.0.0.1:6578/api/health
hermes memory status
```

Wiki: `http://127.0.0.1:6578/wiki` — password from `credentials.json`, not from
the installer transcript. Keyword recall is live.

---

## Phase 2 — Capture layers (do not mix)

**Auto-recall** (already on): prompt-time `POST /api/memory/recall`. This is
“Hermes remembers.” Leave it on.

**Hermes turn capture** (`sync_turn`): writes substantial turns as **draft**
articles. Off by design. It is a no-op unless **both** are set:

- `auto_capture: true`
- a real `topic_id` (create the topic in the wiki first)

Then restart the Hermes session so it reloads `$HERMES_HOME/noosphere.json`.

**Server `NOOSPHERE_AUTO_MEMORY_CAPTURE_ENABLED`**: a different API (HMAC
keyring, capture endpoint, scheduler). The OpenClaw `agent_end` pipeline is
not implemented. Leave this **false** on a Hermes-only VM.

Day-one recipe: auto-recall on, turn capture off, server capture off. Use
`noosphere_save` for curated knowledge.

---

## Phase 3 — llama.cpp embeddings

Hybrid needs `POST /v1/embeddings` where **containers** can reach it. Bind the
Docker bridge, not loopback-only, not LAN.

Do **not** use Ollama.

Verified CPU contract (no CUDA): GGUF `nomic-embed-text-v1.5.Q8_0.gguf`
(768-d), llama.cpp `llama-server --embeddings`. Long articles HTTP 400 unless
context is 8192 with YaRN (400 is not retried; leftover `failed` jobs make the
worker unhealthy).

```text
llama-server \
  -m /path/to/nomic-embed-text-v1.5.Q8_0.gguf \
  --embeddings --alias nomic-embed-text \
  --host 172.17.0.1 --port 8741 \
  -ngl 0 -t 4 \
  -c 8192 -b 8192 -ub 8192 -np 1 \
  --pooling mean \
  --rope-scaling yarn --yarn-orig-ctx 2048 --rope-scale 4
```

Prefer a systemd `--user` unit with linger. Flags and smoke request:
[`HYBRID-RETRIEVAL-ACTIVATION.md`](HYBRID-RETRIEVAL-ACTIVATION.md) appendix.

Host smoke must return `model` = `nomic-embed-text` and 768 finite floats:

```bash
curl -fsS http://172.17.0.1:8741/v1/embeddings \
  -H 'content-type: application/json' \
  -d '{"model":"nomic-embed-text","input":"ping","encoding_format":"float"}' |
  jq -e '.model == "nomic-embed-text" and (.data|length==1) and (.data[0].embedding|length==768)'
```

Then from the compose network. The published app image is `node:22-alpine`
(BusyBox `wget`, no `curl`):

```bash
docker compose --project-directory "${NOOSPHERE_HOME:-$HOME/.noosphere}" -f "${NOOSPHERE_HOME:-$HOME/.noosphere}/docker-compose.yml" exec -T app \
  wget -qO- --header='content-type: application/json' \
  --post-data='{"model":"nomic-embed-text","input":"ping","encoding_format":"float"}' \
  http://host.docker.internal:8741/v1/embeddings
```

App and worker already have `extra_hosts: host.docker.internal:host-gateway`.

---

## Phase 4 — Hybrid on the installer stack

Compose commands in this phase always use:

```bash
export NOOSPHERE_HOME="${NOOSPHERE_HOME:-$HOME/.noosphere}"
compose=(docker compose --project-directory "$NOOSPHERE_HOME" -f "$NOOSPHERE_HOME/docker-compose.yml")
```

Never `docker compose` from a git clone. Never re-run `init`.

### 4.1 Scripts checkout (not the runtime)

```bash
git clone --branch v1.13.2 --depth 1 https://github.com/SweetSophia/noosphere.git ~/src/noosphere-scripts
cd ~/src/noosphere-scripts
test "$(git rev-parse HEAD)" = 11e1be9bb07a60e1df775f33688a7e4dd3dd5645
npm ci
```

That commit is tag `v1.13.2`. `npm ci` is for activators only. Do not run
Compose from this clone.

### 4.2 Snapshot

```bash
umask 077
stamp=$(date +%Y%m%d-%H%M%S)
dest="$NOOSPHERE_HOME/backups/pre-hybrid-A-${stamp}"
mkdir -p "$dest"
chmod 700 "$dest"
cp -a "$NOOSPHERE_HOME/.env" "$dest/.env.bak"
chmod 600 "$dest/.env.bak"
"${compose[@]}" exec -T db pg_dump -U noosphere -d noosphere -Fc >"$dest/pre-hybrid-A.dump"
chmod 600 "$dest/pre-hybrid-A.dump"
pg_restore -l "$dest/pre-hybrid-A.dump" >/dev/null
```

Confirm the writer-authorization marker matches the digest in the **installer**
Compose file (`$NOOSPHERE_HOME/docker-compose.yml`), not the source-checkout
filename `docker-compose.noosphere.yml`:

```bash
set -euo pipefail
marker=$("${compose[@]}" exec -T db cat /run/noosphere-pgvector/writer-authorized)
marker=$(printf '%s' "$marker" | tr -d '\r\n')
test -n "$marker"
db_image=$("${compose[@]}" config --format json | jq -er '.services.db.image')
test "$marker" = "$db_image"
```

Compare against `services.db.image` only. The same digest string also appears in
the app/worker entrypoint gates; `grep` on the whole file can pass after a db
image change. An empty marker, a `cat` failure, or a mismatch — stop.

### 4.3 Role URLs on the compose network

Postgres is not on the host. Activators must talk to hostname `db`. Load
`~/.noosphere/.env` without printing it, percent-encode passwords, export the
five URLs as `postgresql://role:encoded@db:5432/noosphere`.

Roles:

- `noosphere` → `NOOSPHERE_BOOTSTRAP_DATABASE_URL` (`POSTGRES_PASSWORD`)
- `noosphere_migrator` → `DATABASE_URL` (`POSTGRES_MIGRATION_PASSWORD`)
- `noosphere_app` → `NOOSPHERE_APP_DATABASE_URL` (`POSTGRES_APP_PASSWORD`)
- `noosphere_hybrid_admin_login` → `NOOSPHERE_HYBRID_ADMIN_DATABASE_URL`
- `noosphere_hybrid_worker_login` → `NOOSPHERE_HYBRID_WORKER_DATABASE_URL`

Do not paste those URLs into the shell history. A small Python helper that
reads os.environ and prints `export …` lines is enough; inspect with
`echo ${#POSTGRES_PASSWORD}` (length only).

Discover the project network once:

```bash
db_id=$("${compose[@]}" ps -q db)
network=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$db_id")
```

### 4.4 A/B/C + profile, from a sidecar

Host `npm run hybrid-*` cannot resolve hostname `db`. Bundled provenance also
**requires Docker** (`scripts/activate-hybrid-storage.sh` inspects
`NOOSPHERE_DB_CONTAINER`). A `node:22-bookworm` container has neither the
Docker CLI nor the daemon socket, so A/B/C exits before SQL unless you mount
both.

The sidecar therefore needs: Node 22, `psql`, the host Docker CLI, and the
Docker socket. Mounting the socket gives the sidecar the same Docker rights as
the operator — treat that as trusted, local, and temporary.

Build the five URLs in a wrapper that never prints them, then:

```bash
docker_bin=$(command -v docker)
docker run --rm --network "$network" \
  --add-host host.docker.internal:host-gateway \
  -v "$docker_bin":/usr/bin/docker:ro \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$HOME/src/noosphere-scripts:/src" -w /src \
  -e NOOSPHERE_DB_CONTAINER=noosphere-openclaw-db \
  -e NOOSPHERE_BOOTSTRAP_DATABASE_URL \
  -e DATABASE_URL \
  -e NOOSPHERE_APP_DATABASE_URL \
  -e NOOSPHERE_HYBRID_ADMIN_DATABASE_URL \
  -e NOOSPHERE_HYBRID_WORKER_DATABASE_URL \
  node:22-bookworm bash -ceu '
    apt-get update -qq && apt-get install -y -qq postgresql-client jq >/dev/null
    npm run hybrid-storage:activate
    npm run hybrid-worker:activate
    npm run hybrid-retrieval:activate
    profile_json=$(node scripts/hybrid-profile.mjs create \
      --locality local \
      --endpoint http://host.docker.internal:8741/v1/embeddings \
      --model nomic-embed-text \
      --revision Q8_0-b10783 \
      --dimensions 768)
    profile_id=$(printf "%s" "$profile_json" | jq -er .profileId)
    printf "profile_id=%s\n" "$profile_id"
    node scripts/hybrid-profile.mjs prepare --profile "$profile_id"
    node scripts/hybrid-backfill.mjs --profile "$profile_id" --chunk 100
    node scripts/hybrid-profile.mjs status --profile "$profile_id"
  '
```

Prefer a digest-pinned `node:22-bookworm` if your policy requires it (`docker
image inspect --format '{{.RepoDigests}}'`). Repeat activation is
validate-only — do not repair A/B/C by hand.

Copy the printed `profile_id`. Do not expect `$profile_id` to exist in the
host shell — the sidecar is `--rm`. Construct and persist **only**
`NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64` in `$NOOSPHERE_HOME/.env`. Do not leave
`NOOSPHERE_HYBRID_PROVIDER_CONFIG_JSON` set at the same time. `$json` is not
magic — build it from the printed id (empty `apiKey` is valid for local):

```bash
profile_id='00000000-0000-4000-8000-000000000000'  # paste the printed id
uuid_re='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
{ [[ "$profile_id" =~ $uuid_re ]] && test "$profile_id" != '00000000-0000-4000-8000-000000000000'; } \
  || { echo "paste the real printed profile id (got: '${profile_id:-<empty>}')" >&2; exit 1; }
json=$(python3 -c 'import json,sys; print(json.dumps([{"profileId":sys.argv[1],"locality":"local","endpoint":"http://host.docker.internal:8741/v1/embeddings","apiKey":""}],separators=(",",":")))' "$profile_id")
b64=$(printf '%s' "$json" | base64 | tr -d '\n')
test -n "$b64"
python3 - "$b64" <<'PY'
import os, sys, tempfile
env_path = os.path.join(os.environ["NOOSPHERE_HOME"], ".env")
b64 = sys.argv[1]
sets = {"NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64": b64}
out, seen = [], set()
with open(env_path) as f:
    for line in f:
        key = line.split("=", 1)[0] if "=" in line else None
        if key == "NOOSPHERE_HYBRID_PROVIDER_CONFIG_JSON":
            continue  # strip stale JSON form
        if key in sets:
            out.append(key + "=" + sets[key] + "\n")
            seen.add(key)
        else:
            out.append(line)
for key, value in sets.items():
    if key not in seen:
        out.append(key + "=" + value + "\n")
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(env_path))
with os.fdopen(fd, "w") as f:
    f.writelines(out)
    f.flush()
    os.fsync(f.fileno())
os.replace(tmp, env_path)
PY
```

### 4.5 Worker, then two app recreates

```bash
"${compose[@]}" --profile hybrid up -d --no-deps --force-recreate hybrid-worker
```

`--no-deps` keeps `init` from running again. `--force-recreate` picks up the
new B64 (a live worker can keep `W10=` otherwise).

Wait until the worker is **healthy** (compose healthcheck). Any
`embedding_job` in `failed` fails that check — cancel over-context rows;
they stay keyword-only.

Backfill only *queues* jobs. Do **not** `serve` in the create sidecar —
coverage is still ~0 until the worker runs. When `status` shows coverage
≥ 0.95, serve from a **second** sidecar on the same network, substituting the
printed id (host `$profile_id` is unset):

```bash
export NOOSPHERE_HOME="${NOOSPHERE_HOME:-$HOME/.noosphere}"
compose=(docker compose --project-directory "$NOOSPHERE_HOME" -f "$NOOSPHERE_HOME/docker-compose.yml")
db_id=$("${compose[@]}" ps -q db)
network=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$db_id")
test -n "$network"
test -n "${NOOSPHERE_HYBRID_ADMIN_DATABASE_URL:-}"
profile_id='00000000-0000-4000-8000-000000000000'  # paste the printed id
uuid_re='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
{ [[ "$profile_id" =~ $uuid_re ]] && test "$profile_id" != '00000000-0000-4000-8000-000000000000'; } \
  || { echo "paste the real printed profile id (got: '${profile_id:-<empty>}')" >&2; exit 1; }
docker run --rm --network "$network" \
  -v "$HOME/src/noosphere-scripts:/src" -w /src \
  -e NOOSPHERE_HYBRID_ADMIN_DATABASE_URL \
  -e PROFILE_ID="$profile_id" \
  node:22-bookworm bash -ceu '
    apt-get update -qq && apt-get install -y -qq postgresql-client >/dev/null
    node scripts/hybrid-profile.mjs status --profile "$PROFILE_ID"
    node scripts/hybrid-profile.mjs serve --profile "$PROFILE_ID"
  '
```

Write the keyring + profile id into `$NOOSPHERE_HOME/.env` with the flag
still `false` — without these the flag flip fail-closes with
`HybridCorrectnessError` (`query_profile_invalid` / `cache_keyring_invalid`),
not a lexical fallback:

```bash
# profile_id pasted from step 4.4; mint a 32-byte v1 key, never print it
uuid_re='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
{ test -n "$profile_id" && [[ "$profile_id" =~ $uuid_re ]] && test "$profile_id" != '00000000-0000-4000-8000-000000000000'; } \
  || { echo "paste the real printed profile id (got: '${profile_id:-<empty>}')" >&2; exit 1; }
key_b64=$(openssl rand -base64 32)
hmac_b64=$(printf '{"v1":"%s"}' "$key_b64" | base64 | tr -d '\n')
# Both writers share the same os.replace core on purpose: each block is
# self-contained and copy-pasteable in isolation — an operator mid-procedure
# should not need to have run (or even read) the other block first.
python3 - "$profile_id" "$hmac_b64" <<'PY'
import os, sys, tempfile
env_path = os.path.join(os.environ["NOOSPHERE_HOME"], ".env")
sets = {
    "NOOSPHERE_HYBRID_QUERY_PROFILE_ID": sys.argv[1],
    "NOOSPHERE_HYBRID_CACHE_HMAC_ACTIVE_VERSION": "v1",
    "NOOSPHERE_HYBRID_CACHE_HMAC_KEYS_B64": sys.argv[2],
    "NOOSPHERE_HYBRID_RETRIEVAL_ENABLED": "false",
}
out, seen = [], set()
with open(env_path) as f:
    for line in f:
        key = line.split("=", 1)[0] if "=" in line else None
        if key in sets:
            out.append(key + "=" + sets[key] + "\n")
            seen.add(key)
        else:
            out.append(line)
for key, value in sets.items():
    if key not in seen:
        out.append(key + "=" + value + "\n")
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(env_path))
with os.fdopen(fd, "w") as f:
    f.writelines(out)
    f.flush()
    os.fsync(f.fileno())
os.replace(tmp, env_path)
PY
```

Then:

```bash
"${compose[@]}" up -d --no-deps --force-recreate app
"${compose[@]}" exec -T app wget -qO- http://127.0.0.1:3000/api/health
```

`docker compose restart` does **not** reload env. Set
`NOOSPHERE_HYBRID_RETRIEVAL_ENABLED` to the exact string `true`, recreate
app again, health-check again.

The config is parsed per **search request**, not at boot — boot logs stay
clean until the first recall. After the recreate, run one throwaway recall
(any Hermes key, `mode: "auto"`), then check for the fail-closed errors:

```bash
"${compose[@]}" logs app 2>&1 | grep -E 'HybridCorrectnessError|query_profile_invalid|query_profile_missing|cache_keyring_invalid' || true
```

Empty output **after that recall** = config valid; any hit = fix `.env`
before trusting Phase 4.6. Without the recall, empty output proves nothing.

### 4.6 Prove hybrid

`POST /api/memory/recall` returns hits, and app logs
contain **zero** `[hybrid-retrieval] lexical fallback` lines for that
request. (`/api/recall` is an alias of the same handler; the Hermes plugin
uses `/api/memory/recall`.)

---

## Rollback

```bash
export NOOSPHERE_HOME="${NOOSPHERE_HOME:-$HOME/.noosphere}"
compose=(docker compose --project-directory "$NOOSPHERE_HOME" -f "$NOOSPHERE_HOME/docker-compose.yml")
"${compose[@]}" --profile hybrid stop app hybrid-worker
```

Restore the dump from 4.2, set `NOOSPHERE_HYBRID_RETRIEVAL_ENABLED=false`,
recreate app with `--no-deps --force-recreate`. llama.cpp can stay installed.

---

## Pitfalls (installer-specific)

- **Wrong Compose project.** Commands without
  `--project-directory ~/.noosphere` target a different stack or nothing.
- **Wrong DB container / port.** Installer db is `noosphere-openclaw-db`.
  There is no host `:5433`.
- **Sidecar without Docker socket.** Bundled A/B/C inspects
  `NOOSPHERE_DB_CONTAINER=noosphere-openclaw-db` via `docker inspect`. Omit the
  socket/CLI mounts and activation exits before SQL.
- **Re-running `init`.** `up -d` without `--no-deps` on worker/app can
  double-bootstrap.
- **llama.cpp on `127.0.0.1` only.** Containers use `host.docker.internal` →
  docker0 (`172.17.0.1`).
- **llama.cpp on `0.0.0.0`.** Puts embeddings on LAN/Tailscale without a key.
- **HTTP 400 from llama.cpp.** Terminal for that job. Raise ctx/ubatch; do
  not retry.
- **Draft-only corpus.** Agent saves are drafts by default. Recall does **not**
  default to published articles: `metadata.status` is unset on the recall
  path, so unscoped recall returns drafts too. If drafts must stay out of
  agent recall, publish them or scope the API key.

---

## Related

- Guided installer: [`INSTALLATION.md`](INSTALLATION.md)
- Source-compose hybrid how-to: [`HYBRID-RETRIEVAL-ACTIVATION.md`](HYBRID-RETRIEVAL-ACTIVATION.md)
- Hermes plugin: [`../hermes-noosphere-memory/README.md`](../hermes-noosphere-memory/README.md)
- Why hybrid is fail-closed: [`HYBRID-RETRIEVAL-ADR.md`](HYBRID-RETRIEVAL-ADR.md)
