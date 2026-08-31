-- 026_plan_tiers.sql
-- ---------------------------------------------------------------------------
-- Pricing by room size, in two flavours.
--
-- The old model was three named plans and a max player count. The real pricing
-- is a grid: eight size bands, each sold either as one game or as a day of
-- unlimited games. A host does not pick a plan by name — they say how many
-- friends are coming, and the band follows from that. So the band, not the
-- plan, is what the product actually knows.
--
-- Modelled as one row per cell (8 bands x 2 kinds = 16) rather than a formula,
-- because prices are a commercial decision that will be edited from the admin
-- panel and do not follow a clean curve. A table can be changed by the person
-- who owns the decision; a formula can only be changed by a deploy.

ALTER TABLE plans ADD COLUMN IF NOT EXISTS min_players    integer NOT NULL DEFAULT 1;
-- 'single' = one game. 'unlimited_24h' = as many as you like for a day.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS kind           text NOT NULL DEFAULT 'single';
-- NULL for a single game; hours of unlimited play otherwise.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS duration_hours integer;

ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_kind_valid;
ALTER TABLE plans ADD CONSTRAINT plans_kind_valid
  CHECK (kind IN ('single', 'unlimited_24h', 'free_trial'));

ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_band_sane;
ALTER TABLE plans ADD CONSTRAINT plans_band_sane CHECK (min_players <= max_players);

CREATE INDEX IF NOT EXISTS plans_band_idx ON plans(kind, min_players, max_players) WHERE is_active;

-- The old named plans are retired rather than deleted: games already played
-- reference plan_key, and deleting the row would leave that history pointing at
-- nothing.
UPDATE plans SET is_active = false, is_selectable = false
 WHERE plan_key IN ('casual', 'party');

UPDATE plans
   SET min_players = 1, max_players = 1000, kind = 'free_trial'
 WHERE plan_key = 'free_trial';

-- Prices are BEFORE GST. GST_PERCENT is added at checkout and the split is
-- stored on the payment, so a rate change never rewrites an old invoice.
INSERT INTO plans
  (plan_key, name, tagline, description, price_paise, min_players, max_players,
   kind, duration_hours, is_active, is_selectable, display_order)
VALUES
  ('single_10',   'Up to 10',   'One game, up to 10 players.',        '', 3900,   1,   10, 'single', NULL, true, true, 10),
  ('single_25',   'Up to 25',   'One game, up to 25 players.',        '', 7900,  11,   25, 'single', NULL, true, true, 11),
  ('single_50',   'Up to 50',   'One game, up to 50 players.',        '', 12900, 26,   50, 'single', NULL, true, true, 12),
  ('single_100',  'Up to 100',  'One game, up to 100 players.',       '', 19900, 51,  100, 'single', NULL, true, true, 13),
  ('single_200',  'Up to 200',  'One game, up to 200 players.',       '', 34900, 101, 200, 'single', NULL, true, true, 14),
  ('single_300',  'Up to 300',  'One game, up to 300 players.',       '', 49900, 201, 300, 'single', NULL, true, true, 15),
  ('single_500',  'Up to 500',  'One game, up to 500 players.',       '', 69900, 301, 500, 'single', NULL, true, true, 16),
  ('single_1000', 'Up to 1000', 'One game, up to 1000 players.',      '', 99900, 501, 1000, 'single', NULL, true, true, 17),

  ('unlimited_10',   'Day pass 10',   'Unlimited games for 24 hours, up to 10 players.',   '', 6900,   1,   10, 'unlimited_24h', 24, true, true, 20),
  ('unlimited_25',   'Day pass 25',   'Unlimited games for 24 hours, up to 25 players.',   '', 11900, 11,   25, 'unlimited_24h', 24, true, true, 21),
  ('unlimited_50',   'Day pass 50',   'Unlimited games for 24 hours, up to 50 players.',   '', 17900, 26,   50, 'unlimited_24h', 24, true, true, 22),
  ('unlimited_100',  'Day pass 100',  'Unlimited games for 24 hours, up to 100 players.',  '', 29900, 51,  100, 'unlimited_24h', 24, true, true, 23),
  ('unlimited_200',  'Day pass 200',  'Unlimited games for 24 hours, up to 200 players.',  '', 49900, 101, 200, 'unlimited_24h', 24, true, true, 24),
  ('unlimited_300',  'Day pass 300',  'Unlimited games for 24 hours, up to 300 players.',  '', 69900, 201, 300, 'unlimited_24h', 24, true, true, 25),
  ('unlimited_500',  'Day pass 500',  'Unlimited games for 24 hours, up to 500 players.',  '', 99900, 301, 500, 'unlimited_24h', 24, true, true, 26),
  ('unlimited_1000', 'Day pass 1000', 'Unlimited games for 24 hours, up to 1000 players.', '', 149900, 501, 1000, 'unlimited_24h', 24, true, true, 27)
ON CONFLICT (plan_key) DO UPDATE
   SET price_paise   = EXCLUDED.price_paise,
       name          = EXCLUDED.name,
       tagline       = EXCLUDED.tagline,
       min_players   = EXCLUDED.min_players,
       max_players   = EXCLUDED.max_players,
       kind          = EXCLUDED.kind,
       duration_hours = EXCLUDED.duration_hours,
       is_active     = EXCLUDED.is_active,
       display_order = EXCLUDED.display_order,
       updated_at    = now();

-- A day pass, once bought, is what lets a host start rooms without paying again
-- until it expires. Recorded per player rather than per game for that reason.
CREATE TABLE IF NOT EXISTS player_passes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id   uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  plan_key    text NOT NULL,
  max_players integer NOT NULL,
  starts_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  payment_id  uuid REFERENCES payments(id) ON DELETE SET NULL,
  games_used  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS player_passes_active_idx
  ON player_passes(player_id, expires_at DESC);
