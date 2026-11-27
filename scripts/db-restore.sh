#!/usr/bin/env bash
# Restore a backup made by scripts/db-backup.sh into a NEW database (never the live one).
#   scripts/db-restore.sh <backup.dump> <target-db-name>
# The target database must not exist; the script refuses to overwrite anything.
# Promoting a restored database to primary is a deliberate manual step (docs/DEPLOYMENT.md → Restore).
set -euo pipefail

DUMP="${1:?usage: db-restore.sh <backup.dump> <target-db-name>}"
TARGET="${2:?usage: db-restore.sh <backup.dump> <target-db-name>}"
ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_FILE_ARGS="${COMPOSE_FILE_ARGS:--f docker-compose.prod.yml}"
compose() { docker compose ${COMPOSE_FILE_ARGS} --env-file "${ENV_FILE}" "$@"; }

[[ "${TARGET}" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "invalid database name: ${TARGET}" >&2; exit 1; }
[ -s "${DUMP}" ] || { echo "backup file missing or empty: ${DUMP}" >&2; exit 1; }
if [ -f "${DUMP}.sha256" ]; then
  (cd "$(dirname "${DUMP}")" && (sha256sum -c "$(basename "${DUMP}").sha256" 2>/dev/null || shasum -a 256 -c "$(basename "${DUMP}").sha256"))
fi

LIVE_DB=$(compose exec -T postgres sh -c 'printf %s "$POSTGRES_DB"')
if [ "${TARGET}" = "${LIVE_DB}" ]; then
  echo "refusing to restore over the live database '${LIVE_DB}'" >&2; exit 1
fi
EXISTS=$(compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d postgres -tAc \"SELECT 1 FROM pg_database WHERE datname = '${TARGET}'\"")
if [ "${EXISTS}" = "1" ]; then
  echo "database '${TARGET}' already exists; refusing to overwrite (drop it manually if intended)" >&2; exit 1
fi

echo "[restore] creating database ${TARGET}"
compose exec -T postgres sh -c "createdb -U \"\$POSTGRES_USER\" '${TARGET}'"
echo "[restore] restoring ${DUMP}"
compose exec -T postgres sh -c "pg_restore -U \"\$POSTGRES_USER\" -d '${TARGET}' --exit-on-error" < "${DUMP}"
echo "[restore] verifying"
compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d '${TARGET}' -v ON_ERROR_STOP=1 -c \"SELECT filename FROM schema_migrations ORDER BY filename\" -c \"SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('documents','conversations','messages','document_chunks') ORDER BY 1\" -c \"SELECT (SELECT count(*) FROM organizations) orgs, (SELECT count(*) FROM users) users, (SELECT count(*) FROM documents) documents, (SELECT count(*) FROM conversations) conversations\""
echo "[restore] OK — restored into '${TARGET}'"
