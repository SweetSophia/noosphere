# Noosphere — Next.js wiki app Dockerfile
FROM node:22-alpine AS base

# Install dependencies only when needed
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

# Build a production-only node_modules tree with generated Prisma client.
# The runner needs Prisma CLI for first-install migrations/bootstrap, but it should
# not carry dev dependencies from the full build stage.
FROM base AS prod-deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY package.json package-lock.json* ./
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
RUN npm ci --omit=dev && npx prisma generate

# Rebuild the source code when the source changes
FROM base AS builder
ARG DATABASE_URL
ENV DATABASE_URL=$DATABASE_URL
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client
RUN npx prisma generate

RUN npm run build

# Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 noosphere

# Create upload directories
RUN mkdir -p /app/uploads/images && chown noosphere:nodejs /app/uploads /app/uploads/images

COPY --from=builder /app/public ./public
COPY --from=builder --chown=noosphere:nodejs /app/.next/standalone ./
COPY --from=builder --chown=noosphere:nodejs /app/.next/static ./.next/static
COPY --from=prod-deps /app/prisma ./prisma
COPY --from=prod-deps /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/docker ./docker
COPY --from=prod-deps /app/node_modules ./node_modules

# Make migration entrypoint executable (must happen before dropping to noosphere user)
RUN chmod +x /app/docker/docker-entrypoint.sh

USER noosphere

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Run migrations before starting.  "$@" allows docker-compose override.
ENTRYPOINT ["/app/docker/docker-entrypoint.sh"]
CMD ["node", "server.js"]
