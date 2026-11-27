#!/usr/bin/env bash
# PostgreSQL logical backup of the production stack (custom format, compressed).
#   scripts/db-backup.sh [output-dir]          (default: ./backups)
# Env: COMPOSE_FILE_ARGS (default "-f docker-compose.prod.yml"), ENV_FILE (default .env.production),
#      BACKUP_RETENTION_DAYS (default 14; older documind-*.dump files in output-dir are pruned)
# Runs pg_dump inside the postgres container as the owner role; the app keeps running.
set -euo pipefail

OUT_DIR="${1:-./backups}"
ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_FILE_ARGS="${COMPOSE_FILE_ARGS:--f docker-compose.prod.yml}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
compose() { docker compose ${COMPOSE_FILE_ARGS} --env-file "${ENV_FILE}" "$@"; }

mkdir -p "${OUT_DIR}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="${OUT_DIR}/documind-${STAMP}.dump"

echo "[backup] dumping database to ${FILE}"
# -Fc: custom format (compressed, selective restore via pg_restore). Roles are cluster-level and
# are recreated by migrations (002/007), so only the database is dumped.
compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "${FILE}.partial"
mv "${FILE}.partial" "${FILE}"

SIZE=$(wc -c < "${FILE}")
if [ "${SIZE}" -le 0 ]; then echo "[backup] ERROR: empty backup" >&2; exit 1; fi
# Verify the archive is readable (lists the table of contents).
compose exec -T postgres pg_restore --list < "${FILE}" > /dev/null
sha256sum "${FILE}" > "${FILE}.sha256" 2>/dev/null || shasum -a 256 "${FILE}" > "${FILE}.sha256"
echo "[backup] OK ${FILE} (${SIZE} bytes)"

find "${OUT_DIR}" -name 'documind-*.dump*' -type f -mtime "+${RETENTION_DAYS}" -print -delete || true
