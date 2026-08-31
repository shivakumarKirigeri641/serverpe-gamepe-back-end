-- Per-number acknowledgements and the trial-period retention mechanic.

-- One row per player per drawn number. Marks are derived from game_draws (the
-- server is the source of truth), so this table is engagement/presence data and
-- the signal that lets a tick advance before its timeout.
CREATE TABLE IF NOT EXISTS game_draw_responses (
  game_id     uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  seq         integer NOT NULL,
  player_id   uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  has_number  boolean NOT NULL,
  responded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, seq, player_id)
);

CREATE INDEX IF NOT EXISTS game_draw_responses_player_idx ON game_draw_responses(player_id);

-- Aggregated per player. Denormalised on purpose: the leaderboard is read on
-- every 'stats' command and after every game, and this keeps it a single
-- indexed scan rather than a join across claims and games.
CREATE TABLE IF NOT EXISTS player_stats (
  player_id        uuid PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  games_played     integer NOT NULL DEFAULT 0,
  prizes_won       integer NOT NULL DEFAULT 0,
  full_houses      integer NOT NULL DEFAULT 0,
  points           integer NOT NULL DEFAULT 0,
  last_played_at   timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS player_stats_points_idx ON player_stats(points DESC, prizes_won DESC);

-- Weekly buckets so a leaderboard can reset without losing lifetime totals.
CREATE TABLE IF NOT EXISTS player_stats_weekly (
  player_id    uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  week_start   date NOT NULL,
  games_played integer NOT NULL DEFAULT 0,
  prizes_won   integer NOT NULL DEFAULT 0,
  points       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, week_start)
);

CREATE INDEX IF NOT EXISTS player_stats_weekly_board_idx ON player_stats_weekly(week_start, points DESC);
