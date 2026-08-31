# Architecture

MastiPe is a **multi-game platform** that happens to ship with Tambola. The
separation is deliberate and load-bearing: nothing outside `src/games/tambola/`
knows what a tambola ticket is, what 90 numbers mean, or what "Full House" is.

## Layers

```
WhatsApp Cloud API
        │
        ▼
  http/server.ts          signature check, de-dup, 200 immediately
        │
        ▼
  whatsapp/parse.ts       Meta's envelope  →  InboundEvent
        │
        ▼
  services/conversation   what did the player mean?   ← no game-specific text
        │
        ├── services/game.service      rooms, joins, draws, claims (generic)
        ├── services/round.service     per-tick fan-out to players
        ├── services/stats.service     leaderboard
        └── services/wallet.service    ledger (dormant during the free trial)
        │
        ▼
  core/registry  ──►  GameEngine   ← ALL game rules live behind this
                          │
                          └── games/tambola/
```

`workers/draw.worker.ts` consumes a BullMQ queue and calls back into
`round.service` — the same path, driven by a timer instead of a message.

## The engine contract

`src/core/types.ts` defines `GameEngine`. An engine owns:

| Concern | Method |
| --- | --- |
| Identity | `key`, `displayName`, `description`, `entryNoun` |
| Limits | `minPlayers`, `maxPlayers`, `maxEntriesPerPlayer` |
| Prizes | `claims()` — key, label, order, prize share |
| Setup | `defaultConfig()`, `createState()`, `createEntry()` |
| Play | `draw()`, `validateClaim()`, `isFinished()` |
| Presentation | `helpText()`, `ackPrompt()`, `renderEntry()`, `renderDraw()` |

Engine methods are **pure**. `draw()` returns the next state rather than
mutating, which is what makes a round replayable and the tests trivial.

## Persistence is game-agnostic

No table mentions tambola. `games.game_key` selects the engine, and everything
game-shaped lives in `jsonb`:

- `games.config` — the engine's config object
- `games.state` — the engine's state (for Tambola: the shuffled sequence + cursor)
- `game_entries.payload` — one player's board (for Tambola: the 3×9 grid)

So **a new game needs no migration.**

## Why the draw sequence is shuffled up front

`createState()` shuffles all 90 numbers once and stores the order. Each tick
just advances a cursor. This costs nothing and means any disputed round can be
replayed exactly — and with `config.seed` set, reproduced from scratch.

## Concurrency

Three things can race: the timeout job, an early advance when every player has
answered, and two players claiming the same prize at the same instant.

- `performDraw()` takes `SELECT … FOR UPDATE` on the game row and re-checks the
  expected cursor, so a stale job is a no-op.
- Draw jobs use a deterministic job id (`draw:<gameId>:<seq>`), so the timeout
  and the early advance cannot both be queued.
- A partial unique index on `game_claims (game_id, claim_type) WHERE status =
  'awarded'` is the real guard on prizes. The loser of the race gets told the
  prize has just gone.

## Adding a second game

1. Create `src/games/<yourgame>/engine.ts` implementing `GameEngine`.
2. Register it in `src/games/index.ts`.

That's it. You automatically get: rooms and room codes, join links, the lobby,
the draw scheduler, per-tick fan-out, the claim flow, the wallet, stats and the
leaderboard, and a main menu that switches from three buttons to a game picker
list on its own.

What you'll want to check when you do:

- **`ackPrompt()`** — the question asked each tick. For a card game this might
  be "Play a card?" rather than "Is 42 on your board?".
- **`renderEntry()`** — must fit a phone screen. The Tambola grid is 27
  characters wide inside a WhatsApp monospace fence, which is about the limit.
- **`claims()` prize shares** should sum to 1.0 (there's a test for Tambola's).
- **The Flow** (`src/whatsapp/flows/game-flow.json`) uses game-neutral field
  names — `call_label`, `board_text`, `question_label` — so a second game reuses
  the published Flow rather than needing its own.

## Deliberate limits

- **Draws are numeric.** `DrawResult.value` is a `number`. A game that reveals
  cards or words would need this widened to a generic payload.
- **One active game per player**, enforced in `findActiveGameForPlayer`.
- **The API and the draw worker run in one process** (`src/index.ts`). Split
  them with `npm run worker` when traffic justifies it — the queue already
  supports it.
