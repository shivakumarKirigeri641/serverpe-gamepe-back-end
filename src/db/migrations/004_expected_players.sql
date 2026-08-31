-- The host declares how many players they are expecting when the room is
-- created. It is a target for the lobby display, not a hard cap: latecomers can
-- still join up to the engine's maxPlayers, and the host always presses Start.
ALTER TABLE games ADD COLUMN IF NOT EXISTS expected_players integer;

ALTER TABLE games ADD CONSTRAINT games_expected_players_range
  CHECK (expected_players IS NULL OR (expected_players >= 1 AND expected_players <= 200));
