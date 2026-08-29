# serverpe-gamepe-back-end

WhatsApp back end for entertainment games. **Tambola** is the first game; the
platform is built so a second one is a new file, not a rewrite.

- **Setup, ngrok and Meta configuration** — [docs/setup.md](docs/setup.md)
- **Architecture and how to add a game** — [docs/architecture.md](docs/architecture.md)

## Stack

Node 20 · TypeScript · Express · Postgres · Redis · BullMQ · WhatsApp Cloud API

## Quick start

```bash
npm install
cp .env.example .env      # set DATABASE_URL and REDIS_URL
npm run migrate
npm run dev
```

With no WhatsApp credentials the send client logs outbound messages instead of
sending them, so a full round can be played locally against simulated webhooks.

## Player flow

```
hi  →  menu  →  Play Tambola  →  room code + ticket
                              →  friends send  JOIN <CODE>
                              →  host taps Start
                              →  a number every 8s, each with your marked ticket
                                 and "do you have it?"
                              →  tap a prize to claim; server validates
                              →  Full House ends the game
```

Any time: `ticket` · `status` · `stats` · `board` · `leave` · `help`

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | API + draw worker, watch mode |
| `npm run worker` | Draw worker alone, for a separate process |
| `npm run migrate` | Apply pending SQL migrations |
| `npm test` | Engine and ticket unit tests |
| `npm run typecheck` | `tsc --noEmit` |

## Monetization

Free until `FREE_TRIAL_ENDS_AT` (30 Sep 2026). Wallets, a double-entry ledger
and per-game entry fees already exist in the schema and are exercised by the
join and claim paths — they are simply no-ops while
`isChargingEnabled()` is false. Going live is a config change plus a payment
gateway adapter, not a migration.
