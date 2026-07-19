# Optional hybrid-storage activation

Phase A3 installs the storage boundary for future hybrid retrieval. The optional
Phase B layer adds a provider worker, consent, backfill, and lifecycle controls.
Neither phase changes the current keyword-only query path; exact hybrid recall
remains a separate Phase C activation.

## What activation installs

- `vector` 0.8.1 in the locked `noosphere_vector` schema;
- `pgcrypto` in the locked `noosphere_crypto` schema;
- versioned profiles, vector rows, embedding revisions, durable coalescing jobs,
  and the search-cache epoch in `noosphere_hybrid`;
- article and metadata triggers for revision, deletion, restore, and cache-epoch
  transitions; and
- separate non-superuser administration and worker credentials.

Profiles start `inactive`. Phase A3 rejects `preparing` and `serving`
transitions because Phase B has not installed the provider, consent, readiness,
and backfill gates yet. Keyword-only deployments require no activation.

## Privilege model

PostgreSQL does not mark pgvector 0.8.1 as a trusted extension, so its initial
installation requires superuser authority. Activation splits that unavoidable
step from feature DDL:

1. the bootstrap superuser gives temporary superuser authority to an
   unloginable extension owner only while creating the two extension schemas;
2. a separate unloginable activator receives transaction-scoped database
   `CREATE` and feature-owner membership for feature DDL;
3. both temporary grants are revoked before commit; and
4. steady-state login roles are limited to one administration or worker
   capability. The application login has no hybrid-schema access.

The elevation and demotion are statements in the same activation transaction.
A disconnect before commit rolls the elevation back; a committed transaction
already contains the final `NOSUPERUSER` state. The extension owner is also
`NOLOGIN`, and repeat activation validates that no privileged role attribute
survived. The unavoidable transient authority exists only inside the connected
bootstrap transaction while `CREATE EXTENSION` runs.

The worker receives identifiers and canonical bytes only from `claim_jobs`; it
has no direct grant on the internal `worker_eligibility` security-barrier,
definer-semantics view. Feature tables do not use RLS in Phase A3: their locked
non-login owner has `NOBYPASSRLS`, base tables have no worker grants, and the
claim path exposes only unrestricted article identifiers and canonical bytes.
It takes an `Article` row lock as the revocation linearization point. At the
default `READ COMMITTED` isolation, a concurrent update is followed and its
eligibility predicates are rechecked; a stale `REPEATABLE READ` snapshot fails
serialization after a restriction commit instead of returning old bytes. Phase
B must install and test explicit
local/remote restricted-content policy before this fail-closed rule can be
broadened. Every definer routine fully qualifies object references and pins
`search_path` to `pg_catalog, pg_temp`.

Deployment initialization deliberately runs
`provision -> migrate -> provision -> bootstrap`. The second provision is
load-bearing: migrations can add public
tables or routines, so runtime grants are revoked and rebuilt from the exact
application function allowlist after every migration. Migration authors adding
an application-callable public routine must add its exact `regprocedure`
signature to `APPLICATION_FUNCTION_ALLOWLIST` in
`docker/provision-database-roles.mjs` together with the migration that owns it.
Before that migration is applied the routine must be absent; afterward it must
resolve and the application role's effective public-function `EXECUTE` set must
match the active allowlist exactly. Repeat activation also rejects any hybrid
schema, relation, routine, or default-ACL grantee outside the locked owner and
capability-role allowlist; direct grants cannot substitute for audited role
membership.

## Activate a bundled database

First complete the guarded pgvector Compose transition and the standard Prisma
migrations. Then provide five distinct database credentials:

```bash
export NOOSPHERE_BOOTSTRAP_DATABASE_URL='postgresql://noosphere:<bootstrap>@127.0.0.1:5433/noosphere'
export DATABASE_URL='postgresql://noosphere_migrator:<migration>@127.0.0.1:5433/noosphere'
export NOOSPHERE_APP_DATABASE_URL='postgresql://noosphere_app:<application>@127.0.0.1:5433/noosphere'
export NOOSPHERE_HYBRID_ADMIN_DATABASE_URL='postgresql://noosphere_hybrid_admin_login:<admin>@127.0.0.1:5433/noosphere'
export NOOSPHERE_HYBRID_WORKER_DATABASE_URL='postgresql://noosphere_hybrid_worker_login:<worker>@127.0.0.1:5433/noosphere'
export NOOSPHERE_DB_CONTAINER='noosphere-db'
npm run hybrid-storage:activate
```

The activator verifies that the running container uses the immutable bundled
image digest before recording its provenance. A repeat invocation succeeds only
when provenance, versions, object owners, role attributes and memberships,
ACLs, default ACLs, triggers, view semantics, and the public-schema fingerprint
match exactly. It never repairs a mismatched activated state.

For an external PostgreSQL 16.14 server (`server_version_num=160014`), set
`NOOSPHERE_HYBRID_PROVENANCE_KIND=external` and provide
`NOOSPHERE_HYBRID_EXTERNAL_IMAGE_DIGEST=external:<sha256>`. The server must
already expose pgvector 0.8.1 and pgcrypto as available extensions. External
provenance is intentionally distinct from the verified bundled-image record,
but activation records and revalidates the same exact PostgreSQL runtime because
the routine manifest is runtime-deparser evidence.

## Activate Phase B

Phase B is a second, independently evidenced activation. It first reconstructs
the original A3 capability ACL inside the uncommitted activation transaction,
runs the complete A3 validator, and then withdraws A3's state/claim/publish/fail
entry points before installing `noosphere_hybrid_b`, two serialized Article triggers,
dynamic local/remote eligibility, consent revocation, coverage-gated lifecycle
transitions, chunked backfill, bounded claims, conditional publication, and
queue-health routines.

Run A3 activation first, then provide the same five role-specific URLs and run:

```bash
npm run hybrid-worker:activate
```

The command hashes all three Phase B SQL artifacts, provisions the limited
logins, exactly revalidates the A3 base, activates or revalidates the B layer in
one transaction, and proves the caller identities. Repeat validation fingerprints
B table columns, defaults, constraints, indexes, routines, ACLs, and the exact
Article-trigger inventory. It never starts a worker or changes a profile from
`inactive`. After B activation, use this command for repeat validation; the raw
A3 activator intentionally rejects B's narrower, superseding capability ACL.

### Create and prepare a local profile

Provider endpoints and credentials are operator configuration, not database
state. Profile identity stores only the SHA-256 of the canonical endpoint.

```bash
export NOOSPHERE_HYBRID_ADMIN_DATABASE_URL='postgresql://noosphere_hybrid_admin_login:<admin>@127.0.0.1:5433/noosphere'

profile_json=$(npm run --silent hybrid:profile -- create \
  --locality local \
  --endpoint http://host.docker.internal:11434/v1/embeddings \
  --model nomic-embed-text \
  --revision operator-pinned-revision \
  --dimensions 768)
profile_id=$(printf '%s' "$profile_json" | jq -er .profileId)

npm run --silent hybrid:profile -- prepare --profile "$profile_id"
npm run --silent hybrid:backfill -- --profile "$profile_id" --chunk 100
```

For a remote profile, use an HTTPS endpoint and grant consent before preparing:

```bash
npm run --silent hybrid:profile -- consent --remote true --restricted-remote false
```

Restricted articles are eligible for local profiles by default. Remote profiles
require general egress consent; restricted remote articles additionally require
`--restricted-remote true`. Revoking either consent deletes affected remote
vectors and jobs and demotes every remote profile to `inactive`. Re-consent does
not restore its prior state.

### Configure and run the worker

Pass the provider mapping to the installer as JSON. The installer validates it,
base64-encodes the bytes to avoid Compose interpolation, and persists only
`NOOSPHERE_HYBRID_PROVIDER_CONFIG_B64` in the mode-0600 runtime `.env`. A remote
mapping must include an API key. Local mappings may omit it, but both HTTP and
HTTPS local endpoints must use loopback or the pinned
`host.docker.internal:host-gateway` mapping.

```dotenv
POSTGRES_HYBRID_WORKER_PASSWORD=<worker-role-password>
NOOSPHERE_HYBRID_PROVIDER_CONFIG_JSON='[{"profileId":"<profile-uuid>","locality":"local","endpoint":"http://host.docker.internal:11434/v1/embeddings","apiKey":""}]' ./install-openclaw.sh
```

The worker is behind a disabled Compose profile:

```bash
docker compose --profile hybrid up -d hybrid-worker
npm run --silent hybrid:profile -- status --profile "$profile_id"
npm run --silent hybrid:profile -- serve --profile "$profile_id"
```

`serve` fails until ready vectors cover at least 95% of the currently eligible
articles at their current revision and hash and the durable backfill generation
created atomically by `prepare` has completed. The backfill command resumes its
database-owned cursor and is limited to 1–1000 rows per transaction; callers
cannot supply or skip the cursor. Article writes remain available during
provider outages; one durable `(article, profile)` job always retains the latest
desired revision.

Worker defaults and hard limits are:

- concurrency 4, allowed 1–16;
- lease 120 seconds, allowed 30–900;
- maximum attempts 8, allowed 1–20;
- poll interval 1000 ms, allowed 100–60000;
- provider timeout 30000 ms, allowed 1000–120000;
- response body 4 MiB, hard maximum 16 MiB;
- pending-depth warning/critical 1000/10000; and
- oldest-pending-age warning/critical 300/1800 seconds.

The lease must exceed the provider timeout by at least five seconds. The durable
claim routine enforces the attempt cap across crashes and terminalizes an
expired final lease instead of dispatching again. Critical queue health or any
terminal job failure makes the worker container unhealthy. Logs contain only
bounded event names, job/profile identifiers, counters, and sanitized error
codes. Endpoints, credentials, canonical article bytes, and provider response
bodies are never logged or persisted in error state.

Immediately before each provider request, the worker opens a transaction and
calls the worker-only dispatch-authorizer. That short transaction takes the
eligibility advisory lock and rechecks the exact lease, generation, desired
revision/hash, profile state, article eligibility, and current consent. Its
commit is the dispatch linearization point: a revocation that commits first
suppresses the request, while a later revocation cannot recall bytes already
authorized. The worker commits before HTTP so provider latency never holds a
database lock or blocks Article writes. Publication performs its own exclusive,
complete recheck, and failed authorization releases the exact stale lease
immediately.

## Partial-state recovery

`hybrid capability phase is partial or unsafe` is a fail-closed recovery stop,
not a prompt to rerun provisioning. Stop the application, init job, and any
future worker; preserve the complete error output; take and verify a database
backup before changing catalog state. Inventory the named schemas, capability
roles, and memberships read-only:

```sql
SELECT nspname FROM pg_catalog.pg_namespace
WHERE nspname IN ('noosphere_vector', 'noosphere_crypto', 'noosphere_hybrid')
ORDER BY nspname;

SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
       rolinherit, rolreplication, rolbypassrls
FROM pg_catalog.pg_roles
WHERE pg_catalog.starts_with(rolname, 'noosphere_hybrid_')
ORDER BY rolname;

SELECT member.rolname AS member_name, granted.rolname AS granted_name,
       membership.admin_option, membership.inherit_option, membership.set_option
FROM pg_catalog.pg_auth_members AS membership
JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
WHERE pg_catalog.starts_with(member.rolname, 'noosphere_hybrid_')
   OR pg_catalog.starts_with(granted.rolname, 'noosphere_hybrid_')
ORDER BY member_name, granted_name;
```

Activation is one transaction, so an interrupted supported activation cannot
commit a partial phase. Treat partial state as manual/catalog drift or an
unsupported earlier artifact. The default recovery is restoration of a verified
pre-activation backup. Do not drop schemas, extensions, roles, memberships, or
feature rows merely to make provisioning pass. Any manual reconciliation is an
explicit DBA operation outside this phase: bind it to the preserved backup,
prove object ownership and dependencies, and remove only independently verified
A3 objects before starting again from the clean pre-activation state.

## Verify

Run the disposable source-image and activated-candidate matrix:

```bash
npm run test:hybrid-storage
```

The test owns only uniquely named containers and volumes labeled with its exact
run ID. It verifies the Prisma `migrate deploy`, shadow database, `migrate
diff`, and `db push` no-create/no-drop contract; effective privileges; malicious
temporary-object shadowing; canonical bytes; profile bounds and immutability;
restricted-content worker denial; lease expiry and stale completion;
terminal-failure supersession; soft delete, restore, and hard delete; and
cache-epoch coverage.

## Rollback boundary

Phase A3 and Phase B are opt-in and are not activated by Docker Compose or the
application at startup. Roll back Phase B by deactivating every profile, then
stopping the worker with `docker compose --profile hybrid stop hybrid-worker`.
Inactive profiles are excluded from work and retrieval while their local vector
rows remain available for a controlled re-prepare/backfill. Revoking remote
consent hard-deletes affected remote artifacts. Do not drop either feature
schema as an application migration. Removing activated storage is a separate,
explicit operator action that requires a backup and is outside this phase.
