# CrowdQuest

**Every match moment becomes a quest.** CrowdQuest is a free-to-play, sponsor-funded second-screen experience for football fans. A room turns match events into short, time-boxed questions, locks each answer, resolves it from match state, and updates a points leaderboard.

> **Runtime disclosure:** CrowdQuest starts in deterministic historical replay mode. A valid server-side TxLINE credential is required before the orchestrator can read TxLINE data. The repository does not execute cryptocurrency payouts: it creates capped, metadata-only payout intents in disabled, test, or approval-required states.

CrowdQuest was created for the TxODDS World Cup Hackathon, Consumer and Fan Experiences track, and the Superteam India regional buildathon.

[Live MVP](https://vps.avasis.ai) · [75-second demo](https://vps.avasis.ai/demo.mp4) · [Design system](https://vps.avasis.ai/design-system) · [Runtime source status](https://vps.avasis.ai/v1/source)

![CrowdQuest match room](public/screenshot.jpeg)

## Why CrowdQuest

Most sports products ask a fan to study a dashboard or place a wager. CrowdQuest asks one clear question at the moment it matters. Fans do not stake funds. Sponsors fund the room, fans compete for points, and the product makes source state and settlement state visible.

The core loop is deliberately small:

1. A fan enters a room as a guest.
2. The current match moment opens one deterministic quest template.
3. The fan chooses an answer before the visible timer closes.
4. The next qualifying match event resolves the quest.
5. The room updates points, streak, rank, and a settlement receipt.

The included France–Morocco fixture is a scripted historical demonstration, so judges can complete the whole loop even when no match is active.

## What is implemented

| Capability | Current behavior |
| --- | --- |
| Fan room | Responsive web experience with five quests, answer locking, points, streaks, leaderboard, reset, and completion state |
| Historical demonstration | Deterministic six-event replay for fixture `18209181` |
| Orchestrator API | Fastify service with expiring bearer-owned guest rooms, server answer deadlines, rate limits, concurrent-settlement protection, source status, and protected TxLINE refresh |
| Persistence | In-memory by default; PostgreSQL with expiry cleanup, optimistic versions, and verified scheduled backups in production |
| TxLINE boundary | Server-only guest auth, fixture health check, historical normalization, SSE ingestion, and deterministic TxLINE-derived quest resolution; requires a valid API token |
| Local fallback | The browser remains playable if the orchestrator or TxLINE is unavailable |
| Reward boundary | Capped payout-intent metadata only; no signer, transfer, or completed payout |
| Polar | Optional outbound checkout link for the commercial private-room concept; no subscription lifecycle is implemented |
| Receipts view | Product-level decision receipts and policy explanation; not a Solana proof verifier |

See [TxLINE integration](docs/TXLINE_INTEGRATION.md) for the precise connected/replay behavior, [Security](docs/SECURITY.md) for the trust boundary, and [Production operations](docs/OPERATIONS.md) for deployment and recovery.

## Technology

- Next.js 16 and React 19, built with vinext/Vite for a Cloudflare Worker-compatible frontend
- TypeScript and Tailwind CSS 4
- Local Radix/shadcn-style UI primitives and Lucide icons
- Fastify, Zod, and PostgreSQL for the optional orchestrator
- Node.js `>=22.13.0`

## Run locally

### Frontend only

```bash
npm install
npm run dev
```

The frontend-only path intentionally falls back to the local replay if `/v1/sessions` is unavailable.

### Frontend with the orchestrator

In one terminal:

```bash
cd services/orchestrator
npm install
cp .env.example .env
npm run dev
```

In another terminal:

```bash
cp .env.example .env.local
npm install
npm run dev
```

The checked-in examples point the browser to `http://localhost:8788`. Keep all TxLINE, database, admin, and agent credentials in `services/orchestrator/.env`; never expose them through a `NEXT_PUBLIC_` variable.

TxLINE access is optional for replay development. If a credential is configured, verify the returned runtime status rather than assuming connectivity:

```bash
curl http://localhost:8788/v1/source
```

## Validate

Run the complete frontend, API-contract, secret-signature, and orchestrator suite:

```bash
npm run check
```

## Repository map

```text
app/                         Product and design-system routes
components/ui/               Local interface primitives
lib/demo-data.ts             Browser replay and presentation data
services/orchestrator/       Session, source, resolution, persistence, and intent API
openapi/                     Machine-readable unified API contract
tools/txline/                Safety-constrained devnet activation utility
public/                      Favicon and local flag SVGs
docs/                        Architecture, security, integration, demo, and submission notes
worker/                      vinext Cloudflare Worker entry point
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Security](docs/SECURITY.md)
- [Production operations](docs/OPERATIONS.md)
- [Design system](docs/DESIGN_SYSTEM.md)
- [TxLINE integration](docs/TXLINE_INTEGRATION.md)
- [Unified OpenAPI contract](openapi/crowdquest.openapi.json)
- [Four-minute demo script](docs/DEMO_SCRIPT.md)
- [Form-ready submission copy](docs/SUBMISSION_COPY.md)
- [VPS master activation prompt](deploy/VPS_MASTER_ACTIVATION_PROMPT.md)
- [Dual-submission checklist](docs/SUBMISSION.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## Product boundaries

CrowdQuest is a hackathon MVP, not a betting, custody, or payment product. It does not accept fan stakes. The displayed sponsor pool illustrates a commercial model; it is not evidence that funds are escrowed or transferred. Do not use the current implementation for real-money rewards without identity, authorization, abuse prevention, legal review, ledgering, reconciliation, and a separately audited payout service.
