#!/bin/sh
# Entrypoint for noosphere-app container.
# Runs pending Prisma migrations before starting the application.
set -eu

# Allow operators to bypass migrations for one-off commands (e.g. docker run ... sh).
# Production container restarts always run migrations.
if [ "${SKIP_MIGRATION:-}" = "1" ]; then
  echo "[entrypoint] SKIP_MIGRATION=1 — bypassing migrations"
else
  echo "[entrypoint] Running database migrations..."
  # cd to /app so that the migration script's relative node_modules/prisma path resolves.
  cd /app
  node "/app/docker/migrate-or-baseline.mjs"
  echo "[entrypoint] Migrations complete."
fi

echo "[entrypoint] Starting application: $@"

# Fail fast if CMD is empty to avoid cryptic "exec: not found" error
if [ $# -eq 0 ]; then
  echo "[entrypoint] No command provided — using default: node server.js" >&2
  set -- node server.js
fi

# Pass control to the image's CMD (allows docker-compose override)
exec "$@"
