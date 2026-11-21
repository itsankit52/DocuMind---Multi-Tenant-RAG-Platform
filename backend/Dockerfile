# syntax=docker/dockerfile:1
# DocuMind backend image — one image, two runtime targets:
#   docker build --target api    -t documind-api    backend/
#   docker build --target worker -t documind-worker backend/
# The migration runner (migrate.js) ships in the same image and is invoked as a one-off command.

ARG NODE_VERSION=24-alpine

# ── deps: production dependencies only, from the lockfile ───────────────────────
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ── runtime base: minimal, non-root, tini as PID 1 for signal forwarding ────────
FROM node:${NODE_VERSION} AS runtime
RUN apk add --no-cache tini
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json migrate.js ./
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node src ./src
# No .env is copied (see .dockerignore): all configuration and secrets come from the runtime environment.
USER node
ENTRYPOINT ["/sbin/tini", "--"]

# ── api ─────────────────────────────────────────────────────────────────────────
FROM runtime AS api
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/health/ready" || exit 1
CMD ["node", "src/server.js"]

# ── worker ──────────────────────────────────────────────────────────────────────
FROM runtime AS worker
EXPOSE 9464
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${WORKER_METRICS_PORT:-9464}/health/ready" || exit 1
CMD ["node", "src/worker.js"]
