# Form-ready submission copy

Use the same identity and links for both submissions. Submit the global Consumer and Fan Experiences form first, then the India form before **July 13, 2026 at 11:59 PM IST**.

## Shared fields

**Project title**

CrowdQuest — Every Match Moment Becomes a Quest

**Website**

https://vps.avasis.ai

**Public repository**

https://github.com/celesticlabs/crowdquest

**Demo video**

https://vps.avasis.ai/demo.mp4

**Technical documentation**

https://github.com/celesticlabs/crowdquest/blob/main/docs/ARCHITECTURE.md

## Project description

CrowdQuest turns decisive football moments into free, sponsor-funded micro-quests. Fans lock one answer, the next qualifying match event resolves it, and the room updates points, streaks, rank, and a transparent source receipt. A server-side TxLINE adapter normalizes fixture history and fixture-scoped score SSE into deterministic quest facts, with a clearly labeled historical replay when credentials or sufficient evidence are unavailable. The current MVP never asks fans to stake funds and never transfers rewards automatically: it creates only capped test or approval-required payout-intent metadata.

## TxLINE API feedback

TxLINE’s guest-auth endpoint worked as documented and returned HTTP 200 with the expected JWT shape. The OpenAPI contract and official on-chain examples were especially helpful: they made the two-header access model, fixture-scoped score stream, devnet addresses, subscribe instruction, and `${txSig}::${jwt}` activation message unambiguous. We implemented `/api/fixtures/snapshot`, `/api/scores/historical/{fixtureId}`, `/api/odds/snapshot/{fixtureId}`, and `/api/scores/stream` behind a server-only adapter, then project normalized score events into the five deterministic facts used by fixture `18209181`.

The main friction was activation. Free access still requires a funded Solana devnet fee payer. The official airdrop returned JSON-RPC `-32603 Internal error` or rate-limit responses from the development machine, AWS host, and a clean GitHub runner; `devnet-pow` also requires an initial fee balance. We therefore disclose replay mode instead of fabricating a live connection. A hackathon-scoped read-only token, sponsor-funded activation transaction, or reserved faucet capacity would materially improve onboarding.

## India confirmation

Answer **Yes** to “Did you submit this project to the official World Cup Hackathon?” only after the global form has been submitted successfully. Save both confirmation pages.
