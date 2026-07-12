#!/bin/sh
set -eu

umask 077

fail() {
  printf '%s\n' "crowdquest-backup: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

APP_DIR=${CROWDQUEST_APP_DIR:-/opt/crowdquest-current}
ENV_FILE=${CROWDQUEST_ENV_FILE:-/etc/crowdquest/production.env}
BACKUP_DIR=${CROWDQUEST_BACKUP_DIR:-/var/backups/crowdquest}

require_command docker
require_command sha256sum
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
[ -f "$APP_DIR/docker-compose.yml" ] || fail "active Compose file is unavailable"
[ -r "$ENV_FILE" ] || fail "production environment is unavailable"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

case "${POSTGRES_USER:-}" in
  ""|*[!A-Za-z0-9_]*) fail "POSTGRES_USER must contain only letters, numbers, and underscores" ;;
esac
case "${POSTGRES_DB:-}" in
  ""|*[!A-Za-z0-9_]*) fail "POSTGRES_DB must contain only letters, numbers, and underscores" ;;
esac
case "${CROWDQUEST_BACKUP_RETENTION_DAYS:-14}" in
  ""|*[!0-9]*) fail "CROWDQUEST_BACKUP_RETENTION_DAYS must be a positive integer" ;;
esac
[ "${CROWDQUEST_BACKUP_RETENTION_DAYS:-14}" -ge 1 ] || fail "backup retention must be at least one day"

install -d -m 0700 -o root -g root "$BACKUP_DIR"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
filename="crowdquest-${timestamp}.dump"
temporary=$(mktemp "$BACKUP_DIR/.crowdquest-backup.XXXXXX")
final="$BACKUP_DIR/$filename"

cleanup() {
  rm -f "$temporary"
}
trap cleanup EXIT HUP INT TERM

docker compose --env-file "$ENV_FILE" -f "$APP_DIR/docker-compose.yml" exec -T postgres \
  pg_dump --format=custom --compress=9 --no-owner --no-privileges \
    --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" > "$temporary"

[ -s "$temporary" ] || fail "pg_dump produced an empty backup"
docker compose --env-file "$ENV_FILE" -f "$APP_DIR/docker-compose.yml" exec -T postgres \
  pg_restore --list < "$temporary" >/dev/null

chmod 0600 "$temporary"
mv "$temporary" "$final"
sha256sum "$final" > "$final.sha256"

if [ -n "${CROWDQUEST_BACKUP_S3_URI:-}" ]; then
  require_command aws
  destination=${CROWDQUEST_BACKUP_S3_URI%/}
  aws s3 cp "$final" "$destination/$filename" --only-show-errors
  aws s3 cp "$final.sha256" "$destination/$filename.sha256" --only-show-errors
fi

find "$BACKUP_DIR" -type f \( -name 'crowdquest-*.dump' -o -name 'crowdquest-*.dump.sha256' \) \
  -mtime "+${CROWDQUEST_BACKUP_RETENTION_DAYS:-14}" -delete

bytes=$(wc -c < "$final" | tr -d ' ')
printf 'crowdquest-backup: verified %s (%s bytes)\n' "$final" "$bytes"
