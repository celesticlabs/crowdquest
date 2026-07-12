# Production operations

CrowdQuest is deployed from an immutable release worktree at `/opt/crowdquest-releases/<commit>`. `/opt/crowdquest-current` identifies the active release. Runtime configuration is read from `/etc/crowdquest/production.env`; secret values remain in AWS Systems Manager and root-only files under `/var/lib/crowdquest/secrets`.

## Health and release checks

```bash
readlink -f /opt/crowdquest-current
cd /opt/crowdquest-current
docker compose --env-file /etc/crowdquest/production.env ps
curl -fsS https://vps.avasis.ai/healthz | jq '{status,databaseReady}'
curl -fsS https://vps.avasis.ai/v1/source | jq '{mode,connected,streaming,normalizedEvents,authoritativeQuests}'
```

`databaseReady` must be true. `streaming` means an authenticated SSE response is currently open, not merely that the background loop started. Replay is a valid disclosed state.

## Session controls

Production settings include session TTL, cleanup cadence, answer-window duration, global request limit, and a stricter session-creation limit. Room capabilities are bearer secrets returned once and must never be logged or persisted in analytics. Changing these values requires a controlled Compose redeploy.

## Backups

`crowdquest-backup.timer` runs daily and invokes `/usr/local/sbin/crowdquest-postgres-backup`. Backups are custom-format dumps in `/var/backups/crowdquest`, accompanied by SHA-256 files and verified with `pg_restore --list`. Set `CROWDQUEST_BACKUP_S3_URI` to an approved private bucket for off-host disaster recovery.

```bash
systemctl status crowdquest-backup.timer --no-pager
systemctl list-timers crowdquest-backup.timer --no-pager
sudo systemctl start crowdquest-backup.service
sudo journalctl -u crowdquest-backup.service -n 50 --no-pager
```

Test restoration into an isolated temporary database, never over production. Verify row counts and a representative room snapshot, then destroy only the temporary database. A local-only backup is not disaster recovery; configure off-host storage and perform a scheduled restore drill before handling material rewards.

## Rollback and incidents

Rollback by running `deploy/vps-deploy.sh` from the prior immutable worktree with its commit as `CROWDQUEST_IMAGE_TAG`. Do not delete the PostgreSQL volume. Preserve sanitized service logs and the failing release identifier. Revoke exposed session capabilities by shortening TTL or purging affected sessions; rotate any server credential through its source system and redeploy without printing it.

TxLINE activation, Polar checkout, and Coinbase/on-chain execution are separate evidence-gated changes. A configured endpoint is not proof of a connected source or completed payment.
