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

The launcher is coupled to the coordinated `v1.13.2` image, packages, and
Hermes archive. Before running it, confirm that the
[`v1.13.2` release](https://github.com/SweetSophia/noosphere/releases/tag/v1.13.2)
exists with all six installer assets. Merging the installer source does not by
itself publish those artifacts.

This URL is pinned to an immutable Git commit. It does not execute a moving
`master` or `main` branch:

```bash
curl -fsSL https://raw.githubusercontent.com/SweetSophia/noosphere/ef616729339db2114e53f7b199700379fc3435bb/install.sh | bash
```

The script can prompt through `/dev/tty`, even when it is piped to Bash. It:

1. shows the resolved plan;
2. offers integrations it detects on the machine;
3. determines whether this is a fresh install, interrupted run, or upgrade;
4. downloads the exact backend pinned inside the launcher and verifies its
   SHA-256 before execution;
5. generates distinct runtime credentials without printing them;
6. starts and verifies PostgreSQL, Redis, migrations, bootstrap, and Noosphere;
7. configures the integrations you selected.

On success, open:

```text
http://127.0.0.1:6578/wiki
```

The installer reports the actual URL if you selected a different bind address.

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
key from the default WRITE key and the persisted per-tool WRITE keys. OpenClaw,
Hermes, OpenCode, and Kilo Code receive only their scoped key; the bootstrap key
is never written to tool configuration. OpenClaw's secret-provider file also
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

Examples:

```bash
# Show the plan without changing the machine.
curl -fsSL https://raw.githubusercontent.com/SweetSophia/noosphere/ef616729339db2114e53f7b199700379fc3435bb/install.sh \
  | bash -s -- --dry-run --core-only

# Automation: local Noosphere plus Hermes, without prompts.
curl -fsSL https://raw.githubusercontent.com/SweetSophia/noosphere/ef616729339db2114e53f7b199700379fc3435bb/install.sh \
  | bash -s -- --non-interactive --with hermes
```

`--non-interactive` requires either `--with` or `--core-only`; it never guesses
which agent configuration to mutate.

### Auditable download

If you want to verify the launcher before running it, download first and check
the advertised SHA-256:

```bash
(
  set -e
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  curl -fsSL https://raw.githubusercontent.com/SweetSophia/noosphere/ef616729339db2114e53f7b199700379fc3435bb/install.sh -o "$installer"
  printf '%s  %s\n' 'ea782a679bdbc6c29b9b5d05e60dd98c21580a1829c3a0fa18caf18e10f04cd2' "$installer" | sha256sum -c -
  bash "$installer"
)
```

The launcher independently verifies the backend controller and optional Hermes
bundle before using them.

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
git clone --branch v1.13.2 --depth 1 https://github.com/SweetSophia/noosphere.git
cd noosphere
cp noosphere.env.example .env
```

Edit `.env` and set at least:

- `NOOSPHERE_VERSION=1.13.2`
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

Optional pgvector hybrid storage remains a separate activation step. See
[docker/hybrid-storage/README.md](../docker/hybrid-storage/README.md).
