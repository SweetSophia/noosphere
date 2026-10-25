# Installing Noosphere

This guide separates the recommended guided installer from upgrades and manual
Docker Compose operation. If you only want a local Noosphere instance, start
with the guided path.

## Guided installation

### Prerequisites

Install these first:

- Docker with Docker Compose v2 (`docker compose`)
- Node.js 22 or newer
- `curl`, `jq`, `sha256sum`, `flock`, and `realpath`
- `iproute2` (`ip`) only when binding to a non-loopback IPv4 address

The installer checks its prerequisites before changing the machine.

### Run the installer

The launcher is coupled to the coordinated `v1.15.0` image, packages, and
Hermes archive. Before running it, confirm that the
[`v1.15.0` release](https://github.com/SweetSophia/noosphere/releases/tag/v1.15.0)
exists with all six installer assets. Merging the installer source does not by
itself publish those artifacts.

Use the [verified two-file download](#auditable-download) below. Both files
come from an immutable commit, never a moving `master` or `main` branch.
The script can prompt through `/dev/tty`. It:

1. shows the resolved plan;
2. offers integrations it detects on the machine;
3. determines whether this is a fresh install, interrupted run, or upgrade;
4. verifies the downloaded sibling backend against the launcher's source
   checksum before execution;
5. generates distinct runtime credentials without printing them;
6. starts and verifies PostgreSQL, Redis, migrations, bootstrap, and Noosphere;
7. configures the integrations you selected.

In a source checkout, the launcher instead verifies its adjacent backend against
`SOURCE_BACKEND_SHA256`. The remote URL and `BACKEND_SHA256` remain a separate
published pair until coordinated publication. Packaging binds both checksums to
the packaged backend. Source changes do not update a published backend or image.

On success, open:

```text
http://127.0.0.1:6578/wiki
```

The installer reports the actual URL if you selected a different bind address.

A work VM that already has Hermes, and later wants llama.cpp hybrid retrieval
against this installer runtime (Postgres is **not** on host `:5433`), follow
[Work VM: Hermes + installer + llama.cpp hybrid](HERMES-INSTALLER-HYBRID.md).

### Credentials

Generated administrator credentials are written to:

```text
~/.noosphere/credentials.json
```

The directory is mode `0700` and the file is mode `0600`. The normal installer
output reports only this path; it does not print the password or API key. Read
the file locally when you need to sign in:

```bash
less ~/.noosphere/credentials.json
```

Runtime database and application secrets remain in `~/.noosphere/.env`, also
with mode `0600`. The protected credential file separates the bootstrap ADMIN
key from the default WRITE key and the persisted per-tool WRITE keys. Guided
installation explicitly provisions its **new dedicated bootstrap key** with
`allowedScopes: ["*"]`, because global key management requires both ADMIN
permission and literal full scope. That trusted opt-in is confined to the init
service; integration keys remain WRITE with `allowedScopes: []` (public articles
only). It is not a migration or blanket wildcard backfill.

Reusing an existing key preserves its permissions, scopes, revocation and
principal binding. A revoked key is not reactivated. If a reused credential is
not an unbound full-scope ADMIN key, guided bootstrap fails safely with a recovery
message instead of broadening it. Replace `NOOSPHERE_BOOTSTRAP_API_KEY` in the
protected runtime `.env` with a **new dedicated** credential before retrying, or
deliberately review access in the human ADMIN console. Preserve the old scoped
key; do not silently repurpose an integration key. A temporary process override
alone does not replace the existing persisted bootstrap assignment.

OpenClaw, Hermes, OpenCode, and Kilo Code receive only their scoped key; the
bootstrap key is never written to tool configuration. OpenClaw's secret-provider file also
excludes the bootstrap key. Use `/wiki/admin/keys` later if you want to narrow a
tool further with restricted scopes.

Use `--show-credentials` only when deliberate terminal display is acceptable.
It is never enabled by default.

### Installer options

```text
--with openclaw,hermes,opencode,kilocode
--core-only
--non-interactive
--dry-run
--show-credentials
--help
```

In the [verified two-file download](#auditable-download), append
`--dry-run --core-only` to the final invocation to inspect the plan, or
`--non-interactive --with hermes` to select Hermes without prompts.

`--non-interactive` requires either `--with` or `--core-only`; it never guesses
which agent configuration to mutate.

### Auditable download

Download the launcher and its reviewed backend into one private directory and
check both SHA-256 values before execution. Keeping the sibling filename is
essential: this source launcher retains an older published fallback for
standalone downloads, while these instructions select its reviewed sibling.

```bash
(
  set -e
  installer_dir="$(mktemp -d)"
  trap 'rm -rf "$installer_dir"' EXIT
  installer="$installer_dir/install.sh"
  backend="$installer_dir/install-openclaw.sh"
  unset NOOSPHERE_BACKEND_PATH NOOSPHERE_BACKEND_OVERRIDE_SHA256
  curl -fsSL https://raw.githubusercontent.com/SweetSophia/noosphere/f86e04d4dfc1a31de26b51c43cee3318386d1855/install.sh -o "$installer"
  curl -fsSL https://raw.githubusercontent.com/SweetSophia/noosphere/f86e04d4dfc1a31de26b51c43cee3318386d1855/install-openclaw.sh -o "$backend"
  printf '%s  %s\n' '36949e7abf2e035669f3af4ff5331e44d88b6980c051642073dd8bfd18e98158' "$installer" | sha256sum -c -
  printf '%s  %s\n' '3765d12904a583cd1a513f0622924ee0e71d675ce7225e0ebd90389837e86bee' "$backend" | sha256sum -c -
  bash "$installer"
)
```

The launcher independently verifies the sibling backend and optional Hermes
bundle before using them. The temporary directory is removed on exit.

## Fresh install versus upgrade

The same entry point handles both lifecycle paths, but they are not equivalent.

### Fresh installation

A fresh installation has no existing Noosphere runtime state or PostgreSQL data
volume. The controller creates the pinned Compose project, named volumes,
secrets, new-install authorization evidence, database, and application.

### Existing installation

When existing state is detected, the controller uses its guarded resume or
upgrade path. It preserves the named `noosphere_postgres_data` volume, validates
existing evidence, and uses the offline, restore-tested PostgreSQL transition
when an image change requires it. It does not treat the database as disposable.

Before upgrading a customized installation:

1. run the installer with `--dry-run`;
2. preserve your current configuration, database backup, and local repair
   records;
3. review the proposed image and plugin versions;
4. use the detailed
   [PostgreSQL pgvector Compose upgrade](POSTGRES-PGVECTOR-COMPOSE-UPGRADE.md)
   guide if the database transition is not already complete.

Do not replace this with an unrestricted `docker compose pull && docker compose
up`. Existing installations can contain state and local repairs that a naive
fresh-install procedure cannot preserve.

OpenClaw-specific upgrade, troubleshooting, and uninstall procedures are in
[OpenClaw official plugin setup](OPENCLAW-OFFICIAL-PLUGIN-SETUP.md).

## Manual Docker Compose installation

Use this path when you need to control every environment variable or integrate
Noosphere into another deployment system. It is intentionally more detailed
than the guided Quick Start.

```bash
git clone --branch v1.15.0 --depth 1 https://github.com/SweetSophia/noosphere.git
cd noosphere
cp noosphere.env.example .env
```

Edit `.env` and set at least:

- `NOOSPHERE_VERSION=1.15.0`
- distinct `POSTGRES_PASSWORD`, `POSTGRES_MIGRATION_PASSWORD`, and
  `POSTGRES_APP_PASSWORD` values
- `NEXTAUTH_SECRET`
- `NOOSPHERE_ADMIN_PASSWORD`
- `NOOSPHERE_BOOTSTRAP_API_KEY`

Then authorize and initialize a new, absent PostgreSQL volume:

```bash
mkdir -p .noosphere/postgres-pgvector-backups
chmod 700 .noosphere/postgres-pgvector-backups
guard=(./scripts/switch-pgvector-compose.sh --compose-file "$PWD/docker-compose.noosphere.yml" \
  --env-file "$PWD/.env" --db-container noosphere-openclaw-db \
  --app-container noosphere-openclaw-app --backup-dir "$PWD/.noosphere/postgres-pgvector-backups")
"${guard[@]}" --prepare-new-install
docker compose -f docker-compose.noosphere.yml --env-file .env up -d db redis
docker compose -f docker-compose.noosphere.yml --env-file .env run --rm -T init
"${guard[@]}" --record-new-install
docker compose -f docker-compose.noosphere.yml --env-file .env up -d app
```

That sequence is valid only for an absent PostgreSQL volume. If
`noosphere_postgres_data` already exists, follow the existing-volume transition
guide before starting the candidate database image.

### Explicit bootstrap full access

Direct Compose/bootstrap defaults to `NOOSPHERE_BOOTSTRAP_FULL_ACCESS=false`.
A newly inserted key then receives `allowedScopes: []`, which cannot manage
keys even with ADMIN permission. To deliberately provision a **new dedicated**
global-management credential, set `NOOSPHERE_BOOTSTRAP_FULL_ACCESS=true` in the
protected `.env` before running init (ADMIN permission is required). The bootstrap
process accepts only exact `true` and `false` strings. The Compose templates use
`${NOOSPHERE_BOOTSTRAP_FULL_ACCESS:-false}`, so an unset or empty Compose input
resolves to `false` before bootstrap; an empty value passed directly to the
bootstrap process is rejected.

The option never changes a row with a matching key hash. A conflicting scoped,
less-privileged, revoked or principal-bound credential is not upgraded or
reactivated; full-access provisioning aborts and rolls back its transaction.
An already unbound, active ADMIN key containing literal `"*"` can be reused
without changing its scopes or other metadata. Direct callers that do not opt
in can also reuse active scoped credentials unchanged.

### Bootstrap credential file rules

These rules apply to direct Compose/bootstrap operation. The guided installer
avoids this container-lifecycle problem by generating and persisting credentials
on the host first.

If `NOOSPHERE_ADMIN_PASSWORD` or `NOOSPHERE_BOOTSTRAP_API_KEY` is omitted, the
init container writes the generated values to
`/tmp/noosphere-bootstrap-secrets/secrets.json`. The file is mode `0600`, its
parent directory is mode `0700`, and logs contain only the path.

The default `/tmp/...` path disappears when the init container exits. To persist
the file in the uploads volume, set:

```text
NOOSPHERE_BOOTSTRAP_SECRETS_FILE=/app/uploads/bootstrap-secrets/secrets.json
```

The target must be inside a dedicated `bootstrap-secrets` directory. Paths
directly under shared directories such as `/tmp` or `/app/uploads` are rejected.
This restriction is intentional and is not weakened by the guided installer.

## Source development

For a source checkout, use `noosphere.env.example`, `docker-compose.yml`, and the guarded
new-volume or existing-volume procedure above. The local-development commands
remain in the repository [README](../README.md#local-development).

Optional pgvector hybrid storage remains a separate activation step. Operator
how-to (llama.cpp local embeddings):
[HYBRID-RETRIEVAL-ACTIVATION.md](HYBRID-RETRIEVAL-ACTIVATION.md) for source
Compose, or [HERMES-INSTALLER-HYBRID.md](HERMES-INSTALLER-HYBRID.md) for the
guided-installer runtime. SQL/privilege contract:
[docker/hybrid-storage/README.md](../docker/hybrid-storage/README.md).
