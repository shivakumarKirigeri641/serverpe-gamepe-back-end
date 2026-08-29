-- Core platform schema. Deliberately game-agnostic: `games.game_key` selects the
-- engine and all game-specific shape lives in jsonb columns, so a second game
-- needs no DDL.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS players (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_id          text NOT NULL UNIQUE,           -- E.164 without '+', as WhatsApp reports it
  display_name   text,
  locale         text NOT NULL DEFAULT 'en',
  is_blocked     boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS games (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_key         text NOT NULL,                -- 'tambola', future engines here
  room_code        text NOT NULL UNIQUE,
  status           text NOT NULL DEFAULT 'lobby',-- lobby | running | completed | cancelled
  host_player_id   uuid REFERENCES players(id) ON DELETE SET NULL,
  config           jsonb NOT NULL DEFAULT '{}'::jsonb,
  state            jsonb NOT NULL DEFAULT '{}'::jsonb,
  entry_fee_paise  integer NOT NULL DEFAULT 0,
  prize_pool_paise integer NOT NULL DEFAULT 0,
  is_free_trial    boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  ended_at         timestamptz,
  CONSTRAINT games_status_check CHECK (status IN ('lobby','running','completed','cancelled'))
);

CREATE INDEX IF NOT EXISTS games_status_idx ON games(status) WHERE status IN ('lobby','running');
CREATE INDEX IF NOT EXISTS games_game_key_idx ON games(game_key);

CREATE TABLE IF NOT EXISTS game_players (
  game_id    uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id  uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  joined_at  timestamptz NOT NULL DEFAULT now(),
  left_at    timestamptz,
  PRIMARY KEY (game_id, player_id)
);

CREATE INDEX IF NOT EXISTS game_players_player_idx ON game_players(player_id);

-- One row per ticket / board / hand. `payload` is engine-defined.
CREATE TABLE IF NOT EXISTS game_entries (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id    uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id  uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  entry_no   integer NOT NULL DEFAULT 1,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, player_id, entry_no)
);

-- Append-only draw log; `seq` is the authoritative ordering and doubles as an
-- idempotency guard for the draw worker.
CREATE TABLE IF NOT EXISTS game_draws (
  game_id    uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  seq        integer NOT NULL,
  value      integer NOT NULL,
  drawn_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, seq),
  UNIQUE (game_id, value)
);

CREATE TABLE IF NOT EXISTS game_claims (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id       uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id     uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  entry_id      uuid REFERENCES game_entries(id) ON DELETE SET NULL,
  claim_type    text NOT NULL,
  status        text NOT NULL,                   -- awarded | rejected
  reason        text,
  draw_seq      integer NOT NULL,
  prize_paise   integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT game_claims_status_check CHECK (status IN ('awarded','rejected'))
);

CREATE INDEX IF NOT EXISTS game_claims_game_idx ON game_claims(game_id);
-- A prize may only be awarded once per game.
CREATE UNIQUE INDEX IF NOT EXISTS game_claims_awarded_unique
  ON game_claims(game_id, claim_type) WHERE status = 'awarded';

-- Wallet + ledger exist from day one but stay at zero during the free trial.
CREATE TABLE IF NOT EXISTS wallets (
  player_id     uuid PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  balance_paise bigint NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallets_balance_non_negative CHECK (balance_paise >= 0)
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id      uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  amount_paise   bigint NOT NULL,                -- positive credit, negative debit
  kind           text NOT NULL,                  -- topup | entry_fee | prize | refund | adjustment
  reference_type text,
  reference_id   uuid,
  idempotency_key text UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wallet_transactions_player_idx ON wallet_transactions(player_id, created_at DESC);

-- Outbound audit trail: what we sent, to whom, and what it cost.
CREATE TABLE IF NOT EXISTS message_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id   uuid REFERENCES players(id) ON DELETE SET NULL,
  wa_id       text NOT NULL,
  direction   text NOT NULL,                     -- inbound | outbound
  wa_message_id text,
  kind        text,
  body        jsonb,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_log_direction_check CHECK (direction IN ('inbound','outbound'))
);

CREATE INDEX IF NOT EXISTS message_log_created_idx ON message_log(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS message_log_inbound_unique
  ON message_log(wa_message_id) WHERE direction = 'inbound' AND wa_message_id IS NOT NULL;
