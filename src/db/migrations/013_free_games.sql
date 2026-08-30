-- Comped games.
--
-- Kept apart from wallet money on purpose. A free game is not revenue, was
-- never paid for, and must not inflate the credit liability on the Revenue
-- page — so it is counted in games, not in rupees.

ALTER TABLE wallets ADD COLUMN IF NOT EXISTS free_games integer NOT NULL DEFAULT 0;

ALTER TABLE wallets ADD CONSTRAINT wallets_free_games_non_negative
  CHECK (free_games >= 0);

-- Who was given what, by whom, and why. An audit trail for comps matters more
-- than for sales: comps are where favouritism and fraud hide.
CREATE TABLE IF NOT EXISTS free_game_grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id   uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  quantity    integer NOT NULL,
  reason      text NOT NULL,
  granted_by  text NOT NULL,
  campaign    text,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  CONSTRAINT free_game_grants_quantity_check CHECK (quantity <> 0)
);

CREATE INDEX IF NOT EXISTS free_game_grants_player_idx ON free_game_grants(player_id, granted_at DESC);
CREATE INDEX IF NOT EXISTS free_game_grants_campaign_idx ON free_game_grants(campaign);

-- Which games were played on a comp rather than paid for.
ALTER TABLE games ADD COLUMN IF NOT EXISTS paid_with text;

COMMENT ON COLUMN games.paid_with IS 'credits | free_game | trial | null (not yet charged)';
