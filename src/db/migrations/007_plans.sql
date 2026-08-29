-- Plans the host chooses when creating a room.
--
-- Per game, not per player: a plan is bought for a round, like a ticket. As
-- with the legal documents, all wording and pricing lives here so the admin
-- panel can change it without a deploy.

CREATE TABLE IF NOT EXISTS plans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_key       text NOT NULL UNIQUE,
  -- Row title in a WhatsApp list: 24 characters hard limit.
  name           text NOT NULL,
  -- Row description: 72 characters hard limit.
  tagline        text NOT NULL,
  -- Longer copy, shown when a player asks about plans.
  description    text NOT NULL DEFAULT '',
  price_paise    integer NOT NULL DEFAULT 0,
  currency       text NOT NULL DEFAULT 'INR',
  max_players    integer NOT NULL DEFAULT 200,
  -- Visible in the list at all.
  is_active      boolean NOT NULL DEFAULT true,
  -- Selectable, as opposed to shown greyed out as "coming soon".
  is_selectable  boolean NOT NULL DEFAULT true,
  display_order  integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plans_name_len CHECK (char_length(name) <= 24),
  CONSTRAINT plans_tagline_len CHECK (char_length(tagline) <= 72),
  CONSTRAINT plans_price_non_negative CHECK (price_paise >= 0)
);

CREATE INDEX IF NOT EXISTS plans_active_idx ON plans(display_order) WHERE is_active;

-- Which plan a room was created under, and what it cost at the time. Recorded
-- on the game rather than looked up later, so changing a price never rewrites
-- the history of games already played.
ALTER TABLE games ADD COLUMN IF NOT EXISTS plan_key text;
ALTER TABLE games ADD COLUMN IF NOT EXISTS plan_price_paise integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS games_plan_idx ON games(plan_key);

INSERT INTO plans (plan_key, name, tagline, description, price_paise, max_players, is_selectable, display_order)
VALUES
(
  'free_trial',
  'Free Trial',
  'Free to play until 30 September. Up to 30 players.',
  E'*Free Trial*\n\nEverything unlocked, no payment, no card details.\n\n• Up to 30 players per game\n• All six prizes\n• Points and weekly leaderboard\n\nFree until 30 September 2026. We will tell you before anything changes.',
  0,
  30,
  true,
  1
),
(
  'casual',
  'Casual',
  'Coming soon. Small games with friends, up to 10 players.',
  E'*Casual*\n\nFor a quick game with a few friends.\n\n• Up to 10 players\n• All six prizes\n\nNot available yet — free trial is running until 30 September.',
  4900,
  10,
  false,
  2
),
(
  'party',
  'Party',
  'Coming soon. Big rooms, up to 50 players.',
  E'*Party*\n\nFor a full room — family gatherings, office parties, kitty groups.\n\n• Up to 50 players\n• All six prizes\n• Custom room name\n\nNot available yet — free trial is running until 30 September.',
  9900,
  50,
  false,
  3
)
ON CONFLICT (plan_key) DO NOTHING;
