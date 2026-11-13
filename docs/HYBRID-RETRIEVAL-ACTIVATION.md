# Hybrid retrieval — operator activation

There is no wiki toggle. Hybrid retrieval is an explicit operator procedure:
guarded SQL phases, a local OpenAI-compatible embeddings server, a Compose
worker behind `--profile hybrid`, then the application flag.

Keyword-only full-text search remains the runtime default until the flag is the
exact string `true`.

Privilege, SQL, and repeat-validation contracts live in
[`docker/hybrid-storage/README.md`](../docker/hybrid-storage/README.md).
This document is the operator how-to **for a source Compose checkout** (host
Postgres on `127.0.0.1:5433`, db container `noosphere-db`). The ADR
([`HYBRID-RETRIEVAL-ADR.md`](HYBRID-RETRIEVAL-ADR.md)) is why, not how.

If Noosphere was installed with the guided installer (`~/.noosphere`,
containers `noosphere-openclaw-*`, Postgres only on the compose network), do
not follow the host `:5433` steps below. Use
[`HERMES-INSTALLER-HYBRID.md`](HERMES-INSTALLER-HYBRID.md).

## Local embeddings: llama.cpp only

The supported local provider is **llama.cpp** `llama-server` with `--embeddings`
and `POST /v1/embeddings`.

Do **not** use Ollama. It adds a model-manager daemon, extra memory, and slower
embeddings than a CPU-native `llama-server`. Hybrid recall runs on every
eligible memory query; that overhead is not acceptable for a live memory system.

Remote HTTPS providers remain possible (consent required). They are not covered
here.

## Prerequisites

1. Live stack already on the guarded pgvector image (writer-authorization
   marker present). See
   [`POSTGRES-PGVECTOR-COMPOSE-UPGRADE.md`](POSTGRES-PGVECTOR-COMPOSE-UPGRADE.md).
2. App, db, and redis healthy. Do **not** re-run Compose `init` during this
   procedure (`docker compose run --rm init` does not satisfy
   `service_completed_successfully`; a later `up -d` double-bootstraps).
3. `.env` holds the five role passwords (`POSTGRES_PASSWORD`,
   `POSTGRES_MIGRATION_PASSWORD`, `POSTGRES_APP_PASSWORD`,
   `POSTGRES_HYBRID_ADMIN_PASSWORD`, `POSTGRES_HYBRID_WORKER_PASSWORD`) and
   `NOOSPHERE_HYBRID_RETRIEVAL_ENABLED=false`.
4. `llama-server` listening where Docker can reach it. Defaults (override with
   `NOOSPHERE_HYBRID_EMBED_HOST` / `NOOSPHERE_HYBRID_EMBED_PORT` /
   `NOOSPHERE_HYBRID_PROFILE_ENDPOINT`): host bind `172.17.0.1:8741`, container
   URL `http://host.docker.internal:8741/v1/embeddings`. Bind the Docker
   bridge, not LAN `0.0.0.0`.
5. `jq`, `curl`, `pg_dump`/`pg_restore`, Docker Compose, Node enough to run
   the repo `npm run hybrid-*` scripts (`npm ci` if `node_modules` is absent).

## Embeddings contract

The worker and the app POST:

```json
{"model":"<profile model id>","input":"<utf-8 text>","encoding_format":"float"}
```

The response must be `Content-Type: application/json` (charset suffix allowed),
`model` **exactly** equal to the profile's `--model`, and `data[0].embedding` a
finite float array whose length equals `--dimensions`. Extra field
`model_revision` is rejected if present and mismatched; omitting it is fine.

`--alias` on `llama-server` should equal the profile `--model` (verified:
`nomic-embed-text`).

HTTP **400 is not retried**. llama.cpp returns 400 when the prompt exceeds
`n_ctx`. Default GGUF context for nomic-embed-text-v1.5 is 2048; long wiki
articles then terminal-fail on the first attempt. Use 8192 context with YaRN
(see appendix). HTTP 5xx/timeouts are retried up to
`NOOSPHERE_HYBRID_MAX_ATTEMPTS`.

Local endpoints must be loopback or `host.docker.internal` (enforced). Bind
`llama-server` to the Docker bridge (`172.17.0.1`), not `0.0.0.0`, so the
server is not on LAN/Tailscale without a key.

## Operator script

From the repository root:

```bash
npm run hybrid-retrieval:stack
# equivalent: bash scripts/activate-hybrid-retrieval-stack.sh
```

Default is **dry-run**: checks the live stack and embeddings health, prints the
plan, mutates nothing.

```bash
bash scripts/activate-hybrid-retrieval-stack.sh --execute snapshot
bash scripts/activate-hybrid-retrieval-stack.sh --execute activate-sql
bash scripts/activate-hybrid-retrieval-stack.sh --execute profile
bash scripts/activate-hybrid-retrieval-stack.sh --execute worker
bash scripts/activate-hybrid-retrieval-stack.sh --execute enable-flag
```

`--execute all` runs that sequence. The script never prints database URLs or
HMAC material, never starts `init`, and never repairs a mismatched A/B/C
activation (the existing activators already refuse repair).

## Manual sequence (same as the script)

Export the five role URLs from `.env` without putting passwords in history
(host `127.0.0.1:5433` on the source Compose stack):

```bash
set -a
. ./.env
set +a
export NOOSPHERE_BOOTSTRAP_DATABASE_URL="postgresql://noosphere:${POSTGRES_PASSWORD}@127.0.0.1:5433/noosphere"
export DATABASE_URL="postgresql://noosphere_migrator:${POSTGRES_MIGRATION_PASSWORD}@127.0.0.1:5433/noosphere"
export NOOSPHERE_APP_DATABASE_URL="postgresql://noosphere_app:${POSTGRES_APP_PASSWORD}@127.0.0.1:5433/noosphere"
export NOOSPHERE_HYBRID_ADMIN_DATABASE_URL="postgresql://noosphere_hybrid_admin_login:${POSTGRES_HYBRID_ADMIN_PASSWORD}@127.0.0.1:5433/noosphere"
export NOOSPHERE_HYBRID_WORKER_DATABASE_URL="postgresql://noosphere_hybrid_worker_login:${POSTGRES_HYBRID_WORKER_PASSWORD}@127.0.0.1:5433/noosphere"
export NOOSPHERE_DB_CONTAINER=noosphere-db
```

1. Snapshot: `pg_dump -Fc` plus a mode-0600 copy of `.env`.
2. `npm run hybrid-storage:activate`
3. `npm run hybrid-worker:activate`
4. `npm run hybrid-retrieval:activate`
5. Create a **local** profile against llama.cpp, then prepare + backfill:

```bash
profile_json=$(npm run --silent hybrid:profile -- create \
  --locality local \
  --endpoint http://host.docker.internal:8741/v1/embeddings \
  --model nomic-embed-text \
  --revision Q8_0-b10783 \
  --dimensions 768)
profile_id=$(printf '%s' "$profile_json" | jq -er .profileId)
npm run --silent hybrid:profile -- prepare --profile "$profile_id"
npm run --silent hybrid:backfill -- --profile "$profile_id" --chunk 100
```

6. Persist `NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64` (canonical base64 of compact
   JSON; empty `apiKey` is valid for local). Mode 0600 on `.env`.
7. Start the worker **without** `init`:

```bash
docker compose --profile hybrid up -d --no-deps --force-recreate hybrid-worker
```

8. Wait until `hybrid:profile status` coverage is at least 0.95, then
   `hybrid:profile serve`.
9. Generate the HMAC keyring without printing it, persist
   `NOOSPHERE_HYBRID_QUERY_PROFILE_ID` and the keyring with the flag still
   `false`, then:

```bash
docker compose up -d --no-deps --force-recreate app
```

   `docker compose restart` does **not** reload environment variables.
10. Confirm keyword recall still works (`/api/health`, wiki 200).
11. Set `NOOSPHERE_HYBRID_RETRIEVAL_ENABLED` to the exact string `true` and
    recreate the app again.
12. Prove hybrid: `POST /api/memory/recall` returns results and the app logs contain
    **zero** `[hybrid-retrieval] lexical fallback` lines for that request.

## Pitfalls (verified)

- **No GUI.** The app role has no hybrid-schema access.
- **`--no-deps --force-recreate` on worker and app recreate.** Omitting `--no-deps` can re-run `init`. Omitting `--force-recreate` can leave a running worker on a stale empty provider mapping.
- **llama.cpp default ubatch 512 / ctx 2048.** Long articles get HTTP 400,
  which the worker treats as terminal. Set `-c 8192 -b 8192 -ub 8192` and YaRN
  (`--rope-scaling yarn --yarn-orig-ctx 2048 --rope-scale 4`).
- **Any `embedding_job` in `failed` makes the worker unhealthy** (`terminalFailed`
  is critical). Articles over 8192 tokens cannot be embedded with this GGUF;
  move those rows to `cancelled` so the worker stays healthy. They remain
  keyword-only.
- **nomic instruction prefixes.** The worker sends canonical article bytes with
  no `search_document:` / `search_query:` prefix. Index and query are consistent
  and unprefixed; that is not the trained setting.
- **Bind `172.17.0.1`, not `127.0.0.1` only.** Containers reach the host via
  `host.docker.internal` → docker0. Binding loopback-only breaks the worker.
- **Do not repair A/B/C by hand.** Repeat activation is validate-only.

## Rollback

Stop the app and hybrid-worker first so they cannot write during restore:

```bash
docker compose --profile hybrid stop app hybrid-worker
```

Restore the pre-activation `pg_dump`, set
`NOOSPHERE_HYBRID_RETRIEVAL_ENABLED=false`, recreate the app with `--no-deps`.
The llama.cpp unit can stay installed; without the worker it is idle.

## Appendix — verified llama.cpp CPU server

Verified on an Intel i7-7700K (AVX2, 4c/8t), llama.cpp `b10783`
(`f45576aa`), `GGML_NATIVE=ON`, no CUDA.

- Model: `nomic-ai/nomic-embed-text-v1.5-GGUF` `nomic-embed-text-v1.5.Q8_0.gguf`
  (140 MiB, 768-d). Record the SHA-256.
- Wrapper sets `LD_LIBRARY_PATH` to the llama.cpp `build/bin` directory.
- systemd `--user` unit, `Linger=yes`, `ExecStartPre` waits for docker0
  `172.17.0.1`.
- Flags:

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

Smoke, from the host:

```bash
curl -fsS http://172.17.0.1:8741/v1/embeddings \
  -H 'content-type: application/json' \
  -d '{"model":"nomic-embed-text","input":"ping","encoding_format":"float"}'
```

Expect `model` = `nomic-embed-text` and 768 finite floats. Repeat from a
container with `--add-host host.docker.internal:host-gateway` against
`http://host.docker.internal:8741/v1/embeddings` before starting the worker.

## Worker diagnostic log retention (separate from release publication)

The repository Compose templates cap the `hybrid-worker` service's Docker
diagnostics with `max-size: "10m"` and `max-file: "3"`, and pin the
`json-file` driver so the cap applies even when the daemon default differs.
The driver is pinned per service; Docker's daemon-wide default is untouched.
An individual oversized record can briefly exceed `max-size`, so read the
result as approximately 30 MiB of retained Docker log files, not an exact
limit.

That is a **byte** bound, not a retention window. The worker logs one
`worker_batch` line per poll at the default 1s poll and adds a
`worker_job_failed` line per failed attempt, so 30 MiB is on the order of a
day of quiet operation and considerably less during a failure burst. Measure
the deployment's actual log rate before activation and archive or ship
off-box any evidence older than the implied window first: rotation is not a
replacement for incident evidence.

Scope: `docker-compose.yml` and `docker-compose.noosphere.yml` carry the cap.
The Compose template embedded in `install-openclaw.sh` does not - that file is
a digest-pinned published artifact, so changing it requires the coordinated
release digest cascade and is deliberately out of scope here. A deployment
whose worker still runs from an installer-generated Compose file stays
uncapped until that release lands; `docs/HERMES-INSTALLER-HYBRID.md` covers
that stack's compose invocation.

This procedure applies only where the worker's own Compose file actually
declares the cap. Before step 1, resolve the worker's Compose file (the
discovery block in step 3 records it) and confirm it declares the `logging:`
block with `max-size: "10m"` and `max-file: "3"` for `hybrid-worker`. A
worker still running from an installer-generated Compose file has nothing to
activate here: the cap arrives with the release that changes that template, so
wait for that release instead of running this procedure. On such a stack the
step 6 `LogConfig` check can never pass, and this runbook does not ask the
operator to fake it.

Activation belongs to the next approved worker deployment unless disk pressure
requires separately approved immediate action. Before recreating the worker:

1. Preserve a timestamp-bounded `docker logs --timestamps` snapshot in a
   private archive (directory mode 0700, file mode 0600); verify non-empty contents and
   record its SHA-256, window bounds and container ID. Run the discovery block
   in step 3 first to resolve `$container`, then create the archive and capture
   the snapshot:

   ```bash
   capture_initial_worker_logs() {
     : "${archive:?set archive to a private path}"
     [ "${worker_ready:-}" = yes ] || return 1
     : "${container:?run the step 3 discovery block first}"
     unset initial_capture_ready final_capture_ready
     install -d -m 0700 "$archive" || return 1
     umask 077
     # Set start to the incident start; cutoff is the capture instant.
     start=2026-01-01T00:00:00Z
     cutoff=$(date -u +%Y-%m-%dT%H:%M:%SZ) || return 1
     docker logs --timestamps --since "$start" --until "$cutoff" "$container" \
       > "$archive/worker-before.log" 2>&1 || {
       printf 'initial log capture failed; retain partial evidence and do not continue\n' >&2
       return 1
     }
     # Plain-text archive: no decompression step is implied.
     python3 - "$archive/worker-before.log" "$start" "$cutoff" "$container" <<'PYVERIFY'
import datetime, hashlib, json, pathlib, sys
path, start, cutoff, container = sys.argv[1:]
def instant(value):
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
data = pathlib.Path(path).read_bytes()
lines = data.splitlines()
assert data and lines, "empty log capture"
times = [instant(line.split(None, 1)[0].decode()) for line in lines]
assert instant(start) <= max(times) <= instant(cutoff), "capture outside window"
receipt = {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
           "lines": len(lines), "start": start, "cutoff": cutoff, "container": container}
pathlib.Path(path + ".receipt.json").write_text(json.dumps(receipt) + "\n")
PYVERIFY
     [ "$?" -eq 0 ] || return 1
     initial_capture_ready=yes
   }
   archive=/path/to/private/archive
   capture_initial_worker_logs
   ```

   Both stdout and stderr are archived. A non-zero capture status is a hard
   stop, even if the file contains records: retain the partial file and do not
   recreate the worker. An empty file checksums cleanly, so also record the byte count and line count,
   and require both to be non-zero. Bound the capture window on both ends and
   require the newest captured timestamp to fall inside it: at or after
   `$start` and at or before `$cutoff`. A zero-line archive, or one whose
   newest record predates `$start`, proves nothing and counts as a failed
   capture. An upper bound alone cannot express "the capture reaches the
   cutoff", because `--until` returns the records *before* the cutoff by
   construction, so a check for a newest record at or after the cutoff rejects
   every healthy capture and only trains operators to wave it through. A
   mistyped cutoff, a wrong
   container name or a cutoff in the wrong zone all produce a valid, empty
   archive, so discover the worker container by its Compose service label (the
   discovery block in step 3) rather than by a hardcoded name: the same
   `hybrid-worker` service key runs under different container names on the
   source and installer stacks, so a hardcoded name either aborts the discovery
   calls or, with both stacks running, selects the wrong worker. Logs may
   contain sensitive data: keep the archive outside Git. Never truncate
   Docker's active log file.
2. Verify the effective Compose project/files, intended image and writer
   authorization markers. Preserve the deployed image pin and provider mapping;
   this retention change does not authorize an application upgrade or rerun init.
   Record the worker's current log driver and options
   (`docker inspect --format '{{json .HostConfig.LogConfig}}' <container>`) and the
   daemon's default driver (`docker info --format '{{.LoggingDriver}}'`) so the
   pre-change state is on record next to the post-change check in step 6. The
   Compose template pins `json-file` for this service so the cap applies even
   when the daemon default differs; pinning one service does not change the
   daemon default or any other service.
3. Derive the Compose invocation from the running container's own Compose labels
   so that a copy-paste from a checkout cannot resolve to a different project,
   file or image:

   ```bash
   # Discover the worker by its Compose service label. The container name
   # differs between the source and installer stacks, so a hardcoded name
   # aborts these inspect calls on an openclaw-only host and, with both stacks
   # running, can select the wrong worker. Abort unless exactly one worker
   # matches, so an ambiguous host never gets a guess.
   #
   # This is a function, not a bare snippet: `exit 1` in a block an operator
   # pastes into an interactive shell closes that shell - and with it the
   # `$container`, `$compose` and `$archive` values the later steps need.
   # `return 1` aborts the discovery and leaves the session intact.
   discover_worker() {
     unset worker_ready initial_capture_ready final_capture_ready container
     compose=()
     local candidate project config_files working_dir docker_host docker_context
     local docker_config=${DOCKER_CONFIG:-} ambient_name
     local -a workers files candidate_compose
     # Resolve the endpoint before publishing any usable discovery state.
     if [ -n "${DOCKER_CONTEXT:-}" ]; then
       docker_host=$(docker context inspect "$DOCKER_CONTEXT" --format '{{(index .Endpoints "docker").Host}}') || return 1
     elif [ -n "${DOCKER_HOST:-}" ]; then
       docker_host=$DOCKER_HOST
     else
       docker_context=$(docker context show) || return 1
       docker_host=$(docker context inspect "$docker_context" --format '{{(index .Endpoints "docker").Host}}') || return 1
     fi
     # This procedure supports local Unix sockets only, as the installer does.
     case "$docker_host" in unix:///*) ;; *) return 1 ;; esac
     while IFS= read -r ambient_name; do
       case "$ambient_name" in
         DOCKER_*|COMPOSE_*) unset "$ambient_name" || return 1 ;;
       esac
     done < <(compgen -v)
     export DOCKER_HOST="$docker_host"
     if [ -n "$docker_config" ]; then export DOCKER_CONFIG="$docker_config"; fi
     # Do not erase application exports: source deployments may depend on them.
     # Unlike the installer's per-call --env-file usage, this procedure pins
     # the deployed .env when present, then verifies the fully resolved model.
     local candidates
     candidates=$(docker ps -a --filter label=com.docker.compose.service=hybrid-worker --filter label=com.docker.compose.oneoff=False --format '{{.Names}}') || return 1
     [ -n "$candidates" ] || return 1
     mapfile -t workers <<< "$candidates"
     [ "${#workers[@]}" -eq 1 ] || return 1
     candidate=${workers[0]}
     project=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$candidate") || return 1
     config_files=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$candidate") || return 1
     working_dir=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$candidate") || return 1
     [ -n "$project" ] && [ -n "$config_files" ] && [ -d "$working_dir" ] || return 1
     IFS=',' read -ra files <<< "$config_files"
     candidate_compose=(docker compose --project-name "$project" --project-directory "$working_dir")
     for file in "${files[@]}"; do candidate_compose+=(-f "$file"); done
     if [ -f "$working_dir/.env" ]; then candidate_compose+=(--env-file "$working_dir/.env"); fi
     container=$candidate
     compose=("${candidate_compose[@]}")
     worker_ready=yes
   }
   verify_worker_model() {
     [ "${worker_ready:-}" = yes ] || return 1
     local evidence rc=0
     evidence=$(mktemp -d) || return 1
     chmod 0700 "$evidence" || return 1
     # Never print the resolved environment: it can include credentials.
     (umask 077
       docker inspect "$container" > "$evidence/container.json" &&
       "${compose[@]}" --profile hybrid config --format json > "$evidence/model.json" &&
       python3 - "$evidence/container.json" "$evidence/model.json" <<'PYMODEL'
import json, sys
live = json.load(open(sys.argv[1]))[0]["Config"]
worker = json.load(open(sys.argv[2]))["services"]["hybrid-worker"]
env = dict(item.split("=", 1) for item in live["Env"])
expected = worker.get("environment", {})
assert worker["image"] == live["Image"], "worker image differs; abort"
assert all(str(value) == env.get(key) for key, value in expected.items()), "worker environment differs; abort"
assert all(key in expected for key in env if key.startswith("NOOSPHERE_")), "worker provider/configuration omitted; abort"
PYMODEL
     ) || rc=1
     rm -f "$evidence/container.json" "$evidence/model.json"
     rmdir "$evidence"
     return "$rc"
   }
   discover_worker || printf 'discovery failed; worker_ready remains unset; stop here\n' >&2
   ```

   The discovery above runs before every subsequent step and aborts on an
   ambiguous host; run it once and reuse `$container`.

   Never run `docker compose` from a git clone or a template checkout: the
   repository Compose files declare the same project name, so a plain
   `docker compose ... hybrid-worker` executed in a clone resolves to the
   deployed project while applying the clone's service definition, image tag and
   environment. `docs/HERMES-INSTALLER-HYBRID.md` states the same rule for the
   installer stack.
4. Stop the worker and capture a final snapshot immediately before recreating
   it. With the pinned invocation from step 3:

   ```bash
   capture_final_worker_logs() {
     : "${archive:?set archive to a private path}"
     [ "${worker_ready:-}" = yes ] || return 1
     : "${container:?run the step 3 discovery block first}"
     unset final_capture_ready
     [ "${initial_capture_ready:-}" = yes ] || return 1
     verify_worker_model || return 1
     umask 077
     "${compose[@]}" --profile hybrid stop hybrid-worker || return 1
     docker logs --timestamps "$container" > "$archive/final-worker.log" 2>&1 || {
       printf 'final log capture failed; retain old container and do not recreate\n' >&2
       return 1
     }
     [ -s "$archive/final-worker.log" ] || return 1
     [ "$(wc -l < "$archive/final-worker.log")" -gt 0 ] || return 1
     sha256sum "$archive/final-worker.log" > "$archive/final-worker.log.sha256" || return 1
     final_capture_ready=yes
   }
   capture_final_worker_logs
   ```

   The archive directory from step 1 holds both snapshots; keep it out of Git.

   The recreation in step 5 removes the old container and its Docker log file,
   so every line the worker wrote after the step-1 cutoff - including its
   shutdown message - is lost unless it is captured here. Verify the final
   snapshot as in step 1 (non-zero byte and line counts) and keep it in the
   same private archive.
5. Recreate **only** the worker with the same pinned invocation:

   ```bash
   recreate_verified_worker() {
     [ "${worker_ready:-}" = yes ] && [ "${final_capture_ready:-}" = yes ] || return 1
     verify_worker_model || return 1
     "${compose[@]}" --profile hybrid up -d --no-deps --no-build --pull never --force-recreate hybrid-worker
   }
   recreate_verified_worker
   ```

   This step does not authorize an application upgrade: `--no-build --pull never`
   reuses the deployed image, and the pinned project, files, working directory
   and environment (step 3) keep the deployed environment.
6. Verify worker health and inspect its `HostConfig.LogConfig` for `json-file`,
   `max-size=10m`, `max-file=3`. This assertion applies only to a deployment
   that carried the cap before the change; a deployment that never declared it
   is out of scope for this procedure and has no `LogConfig` expectation to
   meet. Confirm app/database container IDs and start times
   are unchanged and no init service ran. Retain the diagnostic archive; rotation
   is not a replacement for incident evidence.

Do not use a broad `docker compose up`, restart the app/database, change Docker's
system-wide defaults, or activate this cap merely to finish a release PR.
