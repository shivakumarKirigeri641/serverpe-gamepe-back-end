/**
 * Player ratings and comments, and the approved subset that becomes
 * testimonials on the marketing site.
 *
 * The rule the marketing site depends on: NOTHING reaches the public page
 * automatically. A comment is published only when an operator approves that
 * exact row in the admin panel. That is what lets the site say every quote is
 * from a real player after a real game and mean it.
 */
import { query } from '../db/pool.js';
import { log } from '../utils/logger.js';
import { notify } from './notification.service.js';

/**
 * One feedback row per player per game, so a second tap corrects the rating
 * rather than stacking up duplicates.
 */
export async function saveRating({ playerId, gameId, rating }) {
  const { rows } = await query(
    `INSERT INTO feedback (player_id, game_id, rating)
          VALUES ($1, $2, $3)
     ON CONFLICT (player_id, COALESCE(game_id, 0)) DO UPDATE SET rating = EXCLUDED.rating
       RETURNING id`,
    [playerId, gameId, rating],
  );
  notify('feedback.given', {
    title: `A player rated a game ${rating}/5`,
    lines: [`Rating: ${rating} of 5`, gameId ? `Game id: ${gameId}` : 'Not about a specific game'],
    playerId, gameId,
  });
  log.info('rating saved', { playerId, gameId, rating });
  return rows[0]?.id ?? null;
}

/** Attaches a comment to the row the rating created, or makes one without. */
export async function saveComment({ playerId, gameId, comment }) {
  const { rows } = await query(
    `INSERT INTO feedback (player_id, game_id, comment)
          VALUES ($1, $2, $3)
     ON CONFLICT (player_id, COALESCE(game_id, 0)) DO UPDATE SET comment = EXCLUDED.comment
       RETURNING id`,
    [playerId, gameId, comment],
  );
  notify('feedback.given', {
    title: 'A player left a comment',
    lines: ['"' + comment.slice(0, 300) + '"'],
    playerId, gameId,
  });
  log.info('comment saved', { playerId, gameId, length: comment.length });
  return rows[0]?.id ?? null;
}

/** Whatever this player already said about this game, if anything. */
export async function existing(playerId, gameId) {
  const { rows } = await query(
    'SELECT * FROM feedback WHERE player_id = $1 AND game_id IS NOT DISTINCT FROM $2',
    [playerId, gameId],
  );
  return rows[0] ?? null;
}

/**
 * The public testimonials list.
 *
 * Only approved rows, only rows with something to read, and only a first name
 * - never a surname, never a number. `display_as` is what the operator typed
 * when approving, so a player is never named in a way they did not agree to.
 */
export async function publishedTestimonials(limit = 12) {
  const { rows } = await query(
    `SELECT f.rating,
            f.comment,
            COALESCE(f.display_as, split_part(COALESCE(p.display_name, 'A player'), ' ', 1)) AS name,
            f.approved_at
       FROM feedback f
       JOIN players p ON p.id = f.player_id
      WHERE f.approved_at IS NOT NULL
        AND f.comment IS NOT NULL
        AND length(btrim(f.comment)) > 0
      ORDER BY f.approved_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    rating: r.rating ?? 0,
    comment: r.comment,
    name: r.name,
  }));
}
