-- Blocking numbers, with a reason and a trail.
--
-- `players.is_blocked` already existed but nothing set it, nothing explained
-- why, and nothing could undo it. A block is a decision with consequences for
-- a real person, so it needs a reason, an author, and a history that survives
-- being lifted.

ALTER TABLE players ADD COLUMN IF NOT EXISTS blocked_at timestamptz;
ALTER TABLE players ADD COLUMN IF NOT EXISTS blocked_reason text;
ALTER TABLE players ADD COLUMN IF NOT EXISTS blocked_by text;

CREATE INDEX IF NOT EXISTS players_blocked_idx ON players(blocked_at DESC) WHERE is_blocked;

-- Every block and unblock, kept even after the block is lifted.
CREATE TABLE IF NOT EXISTS player_blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id   uuid REFERENCES players(id) ON DELETE SET NULL,
  wa_id       text NOT NULL,
  -- block | unblock
  action      text NOT NULL,
  reason      text NOT NULL,
  category    text,
  performed_by text NOT NULL,
  -- Where the report came from, if a player reported it.
  reported_by text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_blocks_action_check CHECK (action IN ('block', 'unblock'))
);

CREATE INDEX IF NOT EXISTS player_blocks_wa_idx ON player_blocks(wa_id, created_at DESC);
CREATE INDEX IF NOT EXISTS player_blocks_created_idx ON player_blocks(created_at DESC);

-- A blocklist keyed on the number rather than the player row, so a block still
-- applies if the player record is ever removed and the number comes back.
CREATE TABLE IF NOT EXISTS blocked_numbers (
  wa_id        text PRIMARY KEY,
  reason       text NOT NULL,
  category     text,
  blocked_by   text NOT NULL,
  blocked_at   timestamptz NOT NULL DEFAULT now(),
  notified_at  timestamptz
);

/* --------------------------------------------------- where players came from */

-- Approximate location, resolved from the board page visit — the only place a
-- real browser (and therefore a real IP) ever reaches us. Never shown to other
-- players; admin only.
ALTER TABLE players ADD COLUMN IF NOT EXISTS last_ip inet;
ALTER TABLE players ADD COLUMN IF NOT EXISTS last_region text;
ALTER TABLE players ADD COLUMN IF NOT EXISTS last_city text;
ALTER TABLE players ADD COLUMN IF NOT EXISTS last_country text;
ALTER TABLE players ADD COLUMN IF NOT EXISTS last_user_agent text;
ALTER TABLE players ADD COLUMN IF NOT EXISTS last_device_at timestamptz;

CREATE INDEX IF NOT EXISTS players_region_idx ON players(last_region);
