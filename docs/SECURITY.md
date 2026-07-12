# Security

CrowdQuest is a production-hardened, free-to-play fan quest service. It is not a custody, betting, identity, or payment system and has not undergone an independent security audit. Real-value rewards remain disabled behind an approval-only metadata boundary.

## Security posture

| Area | Current posture |
| --- | --- |
| Fan authority | Random 256-bit bearer capability scoped to one room and returned once |
| Session retention | 24-hour default TTL, bounded configuration, indexed expiry, scheduled cleanup |
| Answer integrity | Server deadline, active-quest binding, optimistic version check, stale/concurrent rejection |
| Abuse controls | Global and session-creation IP limits, bounded request bodies, strict input validation |
| Fan funds | No deposits, stakes, wallet requirement, signing, or transfer |
| Rewards | Product points and capped payout-intent metadata only |
| TxLINE credential | Server-only secret; raw provider payloads never cross the public boundary |
| Admin refresh | Separate bearer token from AWS SSM Parameter Store |
| Persistence | PostgreSQL on an internal Docker network; expiring JSONB room state |
| Backups | Daily verified custom-format `pg_dump`, 14-day local retention, optional S3 copy |
| Browser fallback | Disclosed local deterministic replay if API authority becomes unavailable |

## Implemented controls

- Zod bounds configuration and request data; request bodies are limited to 16 KiB.
- Each created room receives an unguessable bearer token. Only its SHA-256 digest is stored.
- Room reads, answers, reset, and window reopening require the room bearer token.
- Missing authority returns `401`; invalid, expired, and unknown capabilities share a non-enumerating `404` response.
- Sessions expose `expiresAt`, expire automatically, and are purged from memory or PostgreSQL.
- The server owns `questClosesAt`; an expired answer cannot settle until the authenticated replay window is explicitly reopened.
- Answer writes use optimistic room versions. Two concurrent submissions cannot both advance or score the same quest.
- Public snapshots omit the answer key and every private token digest.
- Global and tighter session-creation limits return `429` with `Retry-After`.
- Disallowed browser origins return a controlled `403`; allowed CORS origins are exact configuration values.
- PostgreSQL writes are parameterized and the database is isolated from the public network.
- TxLINE data is normalized into a narrow fixture domain rather than returned raw.
- Source status says `streaming: true` only while an authenticated SSE response is actively open.
- Payout amounts are capped and the current gateway never signs or submits a transfer.
- The public gateway sets a restrictive CSP, denies framing, limits browser capabilities, and keeps API responses `no-store`.
- Containers are read-only where possible, drop Linux capabilities, use `no-new-privileges`, enforce memory/CPU/PID limits, and expose only a loopback gateway.
- Daily backups are validated with `pg_restore --list`, checksummed, retained with root-only permissions, and may be copied off-host to a configured S3 URI.

## Trust boundaries

### Browser

The browser remains untrusted. The bearer capability authorizes one room but does not establish a person’s legal identity. Browser fallback scores are a demonstration and never become reward authority.

### Orchestrator

The orchestrator owns API-backed score, deadline, version, and receipt state. It never logs or returns stored token hashes. Authorization headers and upstream credentials must remain excluded from structured logs.

### TxLINE

TxLINE is read-only. A configured token does not establish freshness: `connected: true` also requires normalized fixture evidence capable of resolving quests. Replay stays visibly labeled when this evidence is missing.

### Reward agent

`PayoutGateway` creates deterministic intent metadata only. `test` and `approval_required` do not mean submitted, confirmed, reconciled, or paid. No wallet key belongs in this repository or container.

## Remaining requirements before real rewards

1. Authenticated people and role-based sponsor/operator authorization.
2. Server-owned room membership, eligibility, and authoritative leaderboard computation.
3. Bot mitigation beyond rate limits, risk monitoring, and abuse response.
4. An append-only reward ledger with uniqueness, idempotency, and reconciliation.
5. Separate approval and signing services with least-privilege wallets and low limits.
6. Destination allowlists, compliance controls where applicable, and operator review.
7. Centralized audit logs, alerts, incident response, and restore drills.
8. Independent application and smart-contract review.
9. Legal review for promotions, gaming, tax, privacy, consumer protection, and territories.

## Operational requirements

- Configure `CROWDQUEST_BACKUP_S3_URI` for off-host disaster recovery; local backups alone do not protect against instance loss.
- Test a restore into an isolated database before calling backups reliable.
- Keep session and rate limits aligned with observed traffic.
- Rotate database, admin, TxLINE, and agent credentials through AWS SSM.
- Review dependency and container updates before every release; production tags identify the exact Git commit.
- Treat a failing database health check, failed backup timer, or mismatch between image tag and Git release as a deployment failure.

## Secret handling

Never commit or paste these values into issues, screenshots, prompts, videos, or frontend variables:

- `DATABASE_URL` or PostgreSQL password
- room `accessToken`
- `TXLINE_API_TOKEN`
- `COINBASE_AGENT_TOKEN`
- `ADMIN_TOKEN`

Only `NEXT_PUBLIC_CROWDQUEST_API_URL` and a public Polar checkout URL may reach browser code. Rotate any credential immediately if it appears in Git history, logs, or a recording.

## Reporting a vulnerability

Do not post exploitable details in a public issue. Contact the repository owner privately with the route, reproduction steps, impact, and proposed mitigation.
