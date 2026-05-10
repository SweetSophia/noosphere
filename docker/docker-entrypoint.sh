#!/bin/sh
# Entrypoint for noosphere-app container.
# Runs pending Prisma migrations before starting the application.
set -eu

echo "[entrypoint] Running database migrations..."
node "/app/docker/migrate-or-baseline.mjs"
echo "[entrypoint] Migrations complete. Starting application..."

# Pass control to the image's CMD (allows docker-compose override)
exec "$@"
