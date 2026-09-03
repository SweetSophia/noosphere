# Hybrid retrieval — operator activation

There is no wiki toggle. Hybrid retrieval is an explicit operator procedure:
guarded SQL phases, a local OpenAI-compatible embeddings server, a Compose
worker behind `--profile hybrid`, then the application flag.

Keyword-only full-text search remains the runtime default until the flag is the
exact string `true`.

Privilege, SQL, and repeat-validation contracts live in
[`docker/hybrid-storage/README.md`](../docker/hybrid-storage/README.md).
This document is the operator how-to. The ADR
([`HYBRID-RETRIEVAL-ADR.md`](HYBRID-RETRIEVAL-ADR.md)) is why, not how.

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
