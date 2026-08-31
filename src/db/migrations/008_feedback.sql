-- Player feedback collected after a round.
CREATE TABLE IF NOT EXISTS game_feedback (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id    uuid REFERENCES games(id) ON DELETE SET NULL,
  player_id  uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  rating     integer,
  comment    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT game_feedback_rating_range CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5))
);

CREATE INDEX IF NOT EXISTS game_feedback_created_idx ON game_feedback(created_at DESC);
CREATE INDEX IF NOT EXISTS game_feedback_game_idx ON game_feedback(game_id);
-- One rating per player per game; a later comment updates the same row.
CREATE UNIQUE INDEX IF NOT EXISTS game_feedback_unique ON game_feedback(game_id, player_id);
