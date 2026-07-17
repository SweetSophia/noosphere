# PostgreSQL pgvector Compose upgrade

This runbook covers Noosphere Phase A2b: switching an existing PostgreSQL 16.14 Alpine volume to Noosphere's rehearsed PostgreSQL + pgvector image. It changes only the database image. It does **not** run `CREATE EXTENSION vector`, change the application schema, or enable hybrid retrieval.

## Supported transition

The guard accepts one exact source and one exact candidate:

- source: `postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229` (PostgreSQL 16.14, Alpine 3.23.4);
- candidate: `ghcr.io/sweetsophia/noosphere-postgres-pgvector@sha256:12bc9b34226803a04811a3ddd06feac14121c2c7ce369aaddbd778d242751292` (PostgreSQL 16.14, Alpine 3.24.1, pgvector 0.8.1 available but uninstalled).

The running source may still report the legacy `postgres:16-alpine` configuration string, but its immutable repository digest must resolve to the supported source index. Any other source, candidate, bind mount, remote Docker endpoint, non-local volume driver, unexpected volume consumer, or missing transition evidence is refused.

Both candidate Compose templates mount an external
`noosphere_postgres_authorization` volume read-only. PostgreSQL's entrypoint
requires the exact candidate marker from that volume, so checking out this
revision and running ordinary Compose against a source-created data volume
fails before PostgreSQL starts. Only the guard creates the authorization volume
and marker; it is not a public image override or a persisted environment flag.

## What the guard proves

`scripts/switch-pgvector-compose.sh` holds a per-Docker-engine/per-volume lock from classification through the final restart. It then:

1. authenticates the running source image using its platform-specific OCI identities;
2. fingerprints the complete Docker volume metadata and rejects other consumers;
3. stops the app and database, then uses only networkless maintenance containers;
4. records exact data, schema, Prisma migration-history, and database/collation identities;
5. creates a mode-`0600` custom-format logical backup in an owner-only directory, fsyncs it, records its SHA-256, and restores it into an isolated candidate volume;
6. proves source → candidate → exact source rollback → final candidate while every writer remains stopped;
7. verifies that pgvector 0.8.1 is available from the candidate but that `vector` is uninstalled in every database and template;
8. creates and fingerprints the external candidate-authorization volume only after source rollback and final candidate maintenance verification;
9. atomically promotes the candidate Compose image only after online verification; and
10. writes a durable phase journal bound to the source, candidate, data and authorization volume fingerprints, backup, and integrity evidence.

An interruption before the durable `complete` phase is recovered to the exact source on the next invocation. Recovery atomically replaces the candidate marker with exact-source authorization and restores a source-staged Compose gate before restarting any writer. The restored source remains restartable, while ordinary candidate Compose rejects the source marker and cannot reuse incomplete authorization. The app is restarted only after source rollback and every rollback invariant pass. If rollback cannot be verified, all managed writers remain stopped and the journal path is printed for manual recovery. After `complete`, the guard never rolls back legitimate new application writes.

Docker administrator access is an explicit trust boundary. The lock serializes this guard and installer, and consumer checks detect competing containers, but a privileged administrator can bypass both. Do not run independent Docker or Compose mutations during the maintenance transaction.

## OpenClaw installer deployments

Install and upgrade through the same command:

```bash
curl -fsSL https://raw.githubusercontent.com/SweetSophia/noosphere/master/install-openclaw.sh | bash
```

On an existing supported source install, the installer downloads checksum-pinned guard and deploy-verification scripts, writes the fail-closed candidate Compose gate while leaving the running source container unchanged, performs the full offline transition, then runs bootstrap, application health, exact image/volume/version/extension verification, and minimum data checks. If interrupted after writing Compose but before authorization, an accidental candidate recreation exits before PostgreSQL can touch the source volume.

For a new install, the guard first writes a durable `claim-created` journal while both the named PostgreSQL volume and authorization volume are absent. It then creates the data volume with claim labels, creates the external authorization volume and exact candidate marker, and records both immutable fingerprints as `provisioning`. The installer starts only PostgreSQL/Redis and the one-shot bootstrap, finalizes content signatures as `complete`, and only then starts the application writer. A rerun resumes interruption before or after either volume creation; an unlabeled pre-existing candidate volume cannot be recorded as a new install.

An existing `.env` is preserved byte-for-byte. Configuration precedence is:

1. a non-empty process environment value for the current run;
2. the first exact `KEY=VALUE` assignment in the existing installer-generated `.env`; then
3. the documented installer default.

The installer deliberately does not reinterpret shell quoting, interpolation, duplicate keys, or arbitrary Compose syntax. Keep persistent supported overrides as the simple unquoted assignments generated by the installer. Edit `.env` explicitly when a process-environment override should survive later reruns.

Backups and journals are stored under `~/.noosphere/backups/postgres-pgvector/`.
Keep the completed journal for as long as its PostgreSQL volume exists; future
installer runs use it to distinguish an accepted candidate from an unguarded
image change. Keep the restore-tested logical backup at least until the upgrade
has been operationally accepted and retain it longer when your backup policy
requires. Both contain private deployment evidence, and the logical backup
contains application data.

## Repository deployment: publish the gate before switching

For the one-time Phase A2b transition, fetch and verify the target guard, then fast-forward to the target revision **without running Compose**. The checked-in external-volume gate makes this ordering fail closed: the existing source container keeps running, while an accidental candidate recreation cannot start without guard-created authorization.

```bash
cd /path/to/noosphere
git fetch origin master
target=$(git rev-parse origin/master)
guard=$(mktemp)
git show "$target:scripts/switch-pgvector-compose.sh" > "$guard"
expected=$(git show "$target:install-openclaw.sh" | sed -n "s/^POSTGRES_SWITCH_SCRIPT_SHA256='\([a-f0-9]\{64\}\)'$/\1/p")
test -n "$expected"
test "$(sha256sum "$guard" | awk '{print $1}')" = "$expected"
chmod 700 "$guard"

git merge --ff-only "$target"

"$guard" \
  --compose-file "$PWD/docker-compose.yml" \
  --env-file /absolute/path/to/runtime.env \
  --db-container noosphere-db \
  --app-container noosphere-app \
  --backup-dir /absolute/private/path/postgres-pgvector
```

The guard has now proven the full transition and left the checked-in candidate desired state byte-identical. Verify that no recovery edit remains, then run deployment verification:

```bash
git show "$target:docker-compose.yml" | cmp - docker-compose.yml
git diff --exit-code -- docker-compose.yml
NOOSPHERE_POSTGRES_EVIDENCE=/absolute/private/path/postgres-pgvector/noosphere_postgres_data.phase-a2b.json \
  npm run deploy:verify
```

If `cmp` or `git diff` fails, stop. A verified recovery intentionally leaves a source-staged gate in the working tree. Do not reset, stash, or overwrite it; inspect the journal and keep the recovered source database and app state stable until the discrepancy is understood.

## Recovery and evidence

The active journal is `<backup-dir>/<volume>.phase-a2b.json`. Verified source recovery durably checkpoints `recovered`, restarts and verifies the source app while that journal remains active, then archives it as `.recovered-<run-id>` and exits non-zero so automation cannot mistake rollback for upgrade success. If interrupted after either the recovered checkpoint or source-writer restart, the next invocation re-verifies the exact source and safely finishes recovery.

Recovery deliberately leaves the live Compose file staged for the exact source and its authorization marker. If the installer was interrupted after the durable `recovered` checkpoint, its next invocation first verifies and archives that source state without overwriting the source gate, exits non-zero, and asks for one more rerun. Before a fresh transaction, republish the already-verified target candidate template while leaving the recovered source container running. The following installer invocation does this automatically. In a repository checkout, verify the archived recovery evidence, then restore only the target template and rerun the guard:

```bash
git show "$target:docker-compose.yml" > docker-compose.yml.phase-a2b-target
git show "$target:docker-compose.yml" | cmp - docker-compose.yml.phase-a2b-target
mv docker-compose.yml.phase-a2b-target docker-compose.yml
"$guard" \
  --compose-file "$PWD/docker-compose.yml" \
  --env-file /absolute/path/to/runtime.env \
  --db-container noosphere-db \
  --app-container noosphere-app \
  --backup-dir /absolute/private/path/postgres-pgvector
```

The source marker makes this republished candidate gate refuse ordinary Compose startup until the new guarded transaction authorizes it.

The journal binds the exact invocation, Compose recovery artifacts and their
checksums, volume fingerprint, platform, source/candidate identities, logical
backup checksum, and database integrity signatures. If that evidence is
inconsistent or unsafe, the guard stops the named app writer and refuses to
guess at recovery; preserve the files and investigate manually.

The authorization volume contains two independent markers. The database marker
permits candidate PostgreSQL provisioning only after the guard owns and binds
the volume. The writer marker is absent during migration/bootstrap and is
published only after durable `complete` evidence and live candidate verification;
ordinary Compose therefore cannot start the application early.

New-install journals use `claim-created` → `provisioning` → `complete`.
`claim-created` is written before either volume exists; `provisioning` binds the
guard-created data and authorization volume labels, fingerprints, and candidate
marker; `complete` binds the post-bootstrap database signatures. Only the
prepared journal can be finalized, and the app must be absent or stopped until
finalization succeeds.

For a failed rollback:

- do not restart the app or any scheduler that writes to Noosphere;
- do not run ordinary `docker compose up`;
- retain the journal, run directory, backup, and checksum;
- inspect the exact database container, volume consumers, and guard diagnostics; and
- recover only from the recorded source image and backup evidence.

The logical backup is restore-tested during the transaction, but it is not a substitute for the normal independent backup-retention policy.
