#!/bin/sh
set -eu

fail() {
  printf '%s\n' "crowdquest-operations: $*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "run as root"
[ "$#" -eq 1 ] || fail "usage: install-vps-operations.sh <release-directory>"

APP_DIR=$(CDPATH= cd -- "$1" && pwd -P)
DEPLOY_DIR="$APP_DIR/deploy"
[ -f "$APP_DIR/docker-compose.yml" ] || fail "release Compose file is missing"

ln -sfn "$APP_DIR" /opt/crowdquest-current
install -m 0755 "$DEPLOY_DIR/postgres-backup.sh" /usr/local/sbin/crowdquest-postgres-backup
install -m 0644 "$DEPLOY_DIR/crowdquest-backup.service" /etc/systemd/system/crowdquest-backup.service
install -m 0644 "$DEPLOY_DIR/crowdquest-backup.timer" /etc/systemd/system/crowdquest-backup.timer
install -d -m 0700 -o root -g root /var/backups/crowdquest

systemctl daemon-reload
systemctl enable --now crowdquest-backup.timer
systemctl start crowdquest-backup.service
systemctl is-active --quiet crowdquest-backup.timer || fail "backup timer is not active"
systemctl is-failed --quiet crowdquest-backup.service && fail "initial backup failed"

printf 'CrowdQuest operations installed for %s\n' "$APP_DIR"
