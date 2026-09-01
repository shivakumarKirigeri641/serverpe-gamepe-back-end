-- Approving a player's feedback for publication as a testimonial.
--
-- Nothing a player writes reaches the website by default. Publication is an
-- explicit act by an operator, recorded with who did it and when, because a
-- testimonial is the one place private words become public — and "how did that
-- end up on the internet" needs an answer that is not a guess.
--
-- The display name is copied at approval rather than joined at read time. A
-- player who later changes their WhatsApp profile name has not consented to
-- that new name appearing on a marketing page, and a testimonial that silently
-- rewrites itself is worse than a stale one.

ALTER TABLE game_feedback ADD COLUMN IF NOT EXISTS approved_at   timestamptz;
ALTER TABLE game_feedback ADD COLUMN IF NOT EXISTS approved_by   text;
ALTER TABLE game_feedback ADD COLUMN IF NOT EXISTS display_as    text;

-- Only the approved ones are ever read by the public endpoint, and there will
-- be few of them among many, so the index carries the filter.
CREATE INDEX IF NOT EXISTS game_feedback_approved_idx
  ON game_feedback(approved_at DESC)
  WHERE approved_at IS NOT NULL;

COMMENT ON COLUMN game_feedback.approved_at IS
  'When an operator approved this for publication. NULL = private.';
COMMENT ON COLUMN game_feedback.display_as IS
  'The name shown on the website, captured at approval. Never the phone number.';
