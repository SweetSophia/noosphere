# Optional hybrid-storage activation

Phase A3 installs the storage boundary for future hybrid retrieval. It does not
start an embedding provider, make a profile serve queries, or change the current
keyword-only application path.

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

The worker reads only `worker_eligibility`, a security-barrier,
security-definer view. Feature tables do not use RLS in Phase A3: their locked
non-login owner has `NOBYPASSRLS`, base tables have no worker grants, and the
view exposes canonical bytes and eligible identifiers without raw
`restrictedTags`. Every definer routine fully qualifies object references and
pins `search_path` to `pg_catalog, pg_temp`.

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

For an external PostgreSQL 16 server, set
`NOOSPHERE_HYBRID_PROVENANCE_KIND=external` and provide
`NOOSPHERE_HYBRID_EXTERNAL_IMAGE_DIGEST=external:<sha256>`. The server must
already expose pgvector 0.8.1 and pgcrypto as available extensions. External
provenance is intentionally distinct from the verified bundled-image record.

## Verify

Run the disposable source-image and activated-candidate matrix:

```bash
npm run test:hybrid-storage
```

The test owns only uniquely named containers and volumes labeled with its exact
run ID. It verifies the Prisma `migrate deploy`, shadow database, `migrate
diff`, and `db push` no-create/no-drop contract; effective privileges; malicious
temporary-object shadowing; canonical bytes; profile bounds and immutability;
lease expiry and stale completion; terminal-failure supersession; soft delete,
restore, and hard delete; and cache-epoch coverage.

## Rollback boundary

Phase A3 is opt-in and is not activated by Docker Compose or the application at
startup. Before Phase B writes production vectors, rollback is to leave all
profiles inactive and continue keyword-only operation. Do not drop the feature
schemas as an application migration. Removing activated storage is a separate,
explicit operator action that requires a backup and is outside this phase.
