-- Full-fidelity tracking: an append-only event stream, message attribution,
-- delivery receipts, daily rollups and an archive for aged message bodies.

/* ------------------------------------------------------------------ events */

-- One row per meaningful thing that happens, ever. Everything analytics needs
-- answers from this table alone rather than a six-way join. Append-only: rows
-- are never updated, only archived.
CREATE TABLE IF NOT EXISTS analytics_events (
  id           bigserial PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  event_type   text NOT NULL,
  -- Actors. Any may be null: a webhook from an unknown number has no player yet.
  player_id    uuid REFERENCES players(id) ON DELETE SET NULL,
  game_id      uuid REFERENCES games(id) ON DELETE SET NULL,
  wa_id        text,
  -- 'whatsapp' | 'worker' | 'admin' | 'system'
  source       text NOT NULL DEFAULT 'system',
  -- Event-specific detail. Never store message content here.
  properties   jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Only ever populated for HTTP-originated events (admin panel, future web
  -- clients). WhatsApp players have no IP or user agent - the request comes
  -- from Meta, not from the player's device.
  request_ip   inet,
  user_agent   text,
  admin_actor  text
);

CREATE INDEX IF NOT EXISTS analytics_events_time_idx ON analytics_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS analytics_events_type_time_idx ON analytics_events(event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS analytics_events_player_idx ON analytics_events(player_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS analytics_events_game_idx ON analytics_events(game_id, occurred_at);
CREATE INDEX IF NOT EXISTS analytics_events_props_idx ON analytics_events USING gin (properties);

/* ---------------------------------------------- message attribution + state */

ALTER TABLE message_log ADD COLUMN IF NOT EXISTS game_id uuid REFERENCES games(id) ON DELETE SET NULL;
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS draw_seq integer;
-- accepted | sent | delivered | read | failed
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS status_at timestamptz;
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS read_at timestamptz;
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS failed_at timestamptz;
-- Meta's billing category and error code, when it tells us.
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS pricing_category text;
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS error_code integer;
-- Set when the body has been moved to message_log_archive.
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS message_log_game_idx ON message_log(game_id, created_at);
CREATE INDEX IF NOT EXISTS message_log_player_idx ON message_log(player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS message_log_wa_message_idx ON message_log(wa_message_id) WHERE wa_message_id IS NOT NULL;
-- Drives the archive sweeper.
CREATE INDEX IF NOT EXISTS message_log_unarchived_idx ON message_log(created_at) WHERE archived_at IS NULL;

-- Aged-out message bodies. Kept, not deleted: disputes about a game can still
-- be answered, but the hot table stays small and the content is out of the
-- path of everyday queries.
CREATE TABLE IF NOT EXISTS message_log_archive (
  message_log_id uuid PRIMARY KEY,
  wa_id          text NOT NULL,
  direction      text NOT NULL,
  body           jsonb,
  created_at     timestamptz NOT NULL,
  archived_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS message_log_archive_created_idx ON message_log_archive(created_at);

/* ----------------------------------------------------------------- rollups */

-- Recomputed daily (and on demand) from the raw tables. Cheap to query, safe to
-- rebuild - never the source of truth.
CREATE TABLE IF NOT EXISTS daily_metrics (
  day                    date PRIMARY KEY,
  active_players         integer NOT NULL DEFAULT 0,
  new_players            integer NOT NULL DEFAULT 0,
  returning_players      integer NOT NULL DEFAULT 0,
  games_created          integer NOT NULL DEFAULT 0,
  games_started          integer NOT NULL DEFAULT 0,
  games_completed        integer NOT NULL DEFAULT 0,
  games_abandoned        integer NOT NULL DEFAULT 0,
  total_joins            integer NOT NULL DEFAULT 0,
  numbers_drawn          integer NOT NULL DEFAULT 0,
  acknowledgements       integer NOT NULL DEFAULT 0,
  claims_awarded         integer NOT NULL DEFAULT 0,
  claims_rejected        integer NOT NULL DEFAULT 0,
  messages_inbound       integer NOT NULL DEFAULT 0,
  messages_outbound      integer NOT NULL DEFAULT 0,
  messages_failed        integer NOT NULL DEFAULT 0,
  messages_delivered     integer NOT NULL DEFAULT 0,
  messages_read          integer NOT NULL DEFAULT 0,
  median_response_ms     integer,
  computed_at            timestamptz NOT NULL DEFAULT now()
);

-- Per-player, per-day. Powers retention cohorts and per-player timelines
-- without scanning the event stream.
CREATE TABLE IF NOT EXISTS player_daily_activity (
  player_id        uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  day              date NOT NULL,
  messages_sent    integer NOT NULL DEFAULT 0,
  games_joined     integer NOT NULL DEFAULT 0,
  numbers_answered integer NOT NULL DEFAULT 0,
  prizes_won       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, day)
);

CREATE INDEX IF NOT EXISTS player_daily_activity_day_idx ON player_daily_activity(day);

/* ------------------------------------------------------- admin audit trail */

-- Every admin API call. This is where IP and user agent are genuinely
-- available, because the request comes from a real browser.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id          bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL,
  method      text NOT NULL,
  path        text NOT NULL,
  status_code integer,
  duration_ms integer,
  request_ip  inet,
  user_agent  text,
  query       jsonb
);

CREATE INDEX IF NOT EXISTS admin_audit_log_time_idx ON admin_audit_log(occurred_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_log_actor_idx ON admin_audit_log(actor, occurred_at DESC);
