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

The published image does **not** ship the A/B/C activator scripts or
`docker/hybrid-storage/*.sql`. Keep a shallow scripts checkout for those
commands only; Compose stays in `~/.noosphere`.

---

## Phase 1 — Noosphere + Hermes

### Prerequisites

Docker Compose v2, Node.js 22+, `curl`, `jq`, `sha256sum`, `tar`. Hermes CLI
on `PATH`. If Hermes uses a named profile:

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
  -d '{"model":"nomic-embed-text","input":"ping","encoding_format":"float"}'
```

Then from the compose network (app/worker already have
`extra_hosts: host.docker.internal:host-gateway`):

```bash
docker compose --project-directory "${NOOSPHERE_HOME:-$HOME/.noosphere}" run --rm --no-deps --entrypoint curl app \
  -fsS http://host.docker.internal:8741/v1/embeddings \
  -H 'content-type: application/json' \
  -d '{"model":"nomic-embed-text","input":"ping","encoding_format":"float"}'
```

If the image has no `curl`, run the same URL from any throwaway container on
the project network with `--add-host host.docker.internal:host-gateway`.

---

## Phase 4 — Hybrid on the installer stack

Compose commands in this phase always use:

```bash
export NOOSPHERE_HOME="${NOOSPHERE_HOME:-$HOME/.noosphere}"
compose=(docker compose --project-directory "$NOOSPHERE_HOME")
```

Never `docker compose` from a git clone. Never re-run `init`.

### 4.1 Scripts checkout (not the runtime)

```bash
git clone --branch v1.13.2 --depth 1 https://github.com/SweetSophia/noosphere.git ~/src/noosphere-scripts
cd ~/src/noosphere-scripts
npm ci
```

Pin the branch to the same release as the installer. `npm ci` is for
activators only.

### 4.2 Snapshot

```bash
umask 077
stamp=$(date +%Y%m%d-%H%M%S)
dest="$HOME/.noosphere/backups/pre-hybrid-A-${stamp}"
mkdir -p "$dest"
chmod 700 "$dest"
cp -a "$NOOSPHERE_HOME/.env" "$dest/.env.bak"
chmod 600 "$dest/.env.bak"
"${compose[@]}" exec -T db pg_dump -U noosphere -d noosphere -Fc >"$dest/pre-hybrid-A.dump"
chmod 600 "$dest/pre-hybrid-A.dump"
pg_restore -l "$dest/pre-hybrid-A.dump" >/dev/null
```

Confirm the writer-authorization marker (must match the digest in
`docker-compose.noosphere.yml`):

```bash
"${compose[@]}" exec -T db cat /run/noosphere-pgvector/writer-authorized
```

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

Host `npm run hybrid-*` cannot resolve `db`. Run the clone on that network.
The sidecar needs Node 22 and `psql` (activators call both). Build the five
URLs in a wrapper that never prints them, then pass them as `-e`:

```bash
docker run --rm --network "$network" \
  --add-host host.docker.internal:host-gateway \
  -v "$HOME/src/noosphere-scripts:/src" -w /src \
  -e NOOSPHERE_BOOTSTRAP_DATABASE_URL \
  -e DATABASE_URL \
  -e NOOSPHERE_APP_DATABASE_URL \
  -e NOOSPHERE_HYBRID_ADMIN_DATABASE_URL \
  -e NOOSPHERE_HYBRID_WORKER_DATABASE_URL \
  node:22-bookworm bash -ceu '
    apt-get update -qq && apt-get install -y -qq postgresql-client >/dev/null
    npm run hybrid-storage:activate
    npm run hybrid-worker:activate
    npm run hybrid-retrieval:activate
    node scripts/hybrid-profile.mjs create \
      --locality local \
      --endpoint http://host.docker.internal:8741/v1/embeddings \
      --model nomic-embed-text \
      --revision Q8_0-b10783 \
      --dimensions 768
  '
```

Repeat activation is validate-only — do not repair A/B/C by hand.

`hybrid:profile create` prints a `profileId`. Keep it. Prepare and backfill
with that id (`node scripts/hybrid-profile.mjs prepare|status` and
`node scripts/hybrid-backfill.mjs`). Coverage must be ≥ 0.95 before serving.

Persist **only** `NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64` in
`~/.noosphere/.env` (canonical base64 of compact JSON; empty `apiKey` is
valid for local). Do not leave `NOOSPHERE_HYBRID_PROVIDER_CONFIG_JSON` set at
the same time. Encode portably:

```bash
printf '%s' "$json" | base64 | tr -d '\n'
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

When coverage ≥ 0.95: `hybrid:profile serve`. Write HMAC keyring +
`NOOSPHERE_HYBRID_QUERY_PROFILE_ID` into `~/.noosphere/.env` with the flag
still `false`. Then:

```bash
"${compose[@]}" up -d --no-deps --force-recreate app
"${compose[@]}" exec -T app wget -qO- http://127.0.0.1:3000/api/health
```

`docker compose restart` does **not** reload env. Set
`NOOSPHERE_HYBRID_RETRIEVAL_ENABLED` to the exact string `true`, recreate
app again, health-check again.

### 4.6 Prove hybrid

`POST /api/memory/recall` (not `/api/recall`) returns hits, and app logs
contain **zero** `[hybrid-retrieval] lexical fallback` lines for that
request.

---

## Rollback

```bash
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
- **Re-running `init`.** `up -d` without `--no-deps` on worker/app can
  double-bootstrap.
- **llama.cpp on `127.0.0.1` only.** Containers use `host.docker.internal` →
  docker0 (`172.17.0.1`).
- **llama.cpp on `0.0.0.0`.** Puts embeddings on LAN/Tailscale without a key.
- **HTTP 400 from llama.cpp.** Terminal for that job. Raise ctx/ubatch; do
  not retry.
- **Draft-only corpus.** Agent saves are drafts by default. Unscoped recall
  sees published articles only; admin/`['*']` sees drafts too.

---

## Related

- Guided installer: [`INSTALLATION.md`](INSTALLATION.md)
- Source-compose hybrid how-to: [`HYBRID-RETRIEVAL-ACTIVATION.md`](HYBRID-RETRIEVAL-ACTIVATION.md)
- Hermes plugin: [`../hermes-noosphere-memory/README.md`](../hermes-noosphere-memory/README.md)
- Why hybrid is fail-closed: [`HYBRID-RETRIEVAL-ADR.md`](HYBRID-RETRIEVAL-ADR.md)
