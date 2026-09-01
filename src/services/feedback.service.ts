import { query, queryOne } from '../db/pool.js';
import { notify } from './notification.service.js';

/** Ratings and comments players leave after a round. */

export async function saveRating(gameId: string, playerId: string, rating: number): Promise<void> {
  await query(
    `INSERT INTO game_feedback (game_id, player_id, rating)
     VALUES ($1, $2, $3)
     ON CONFLICT (game_id, player_id) DO UPDATE SET rating = EXCLUDED.rating, created_at = now()`,
    [gameId, playerId, rating],
  );

  void notify({
    trigger: 'feedback.received',
    summary: `Rated ${rating}/5`,
    gameId,
    playerId,
    detail: { rating },
  });
}

/** Attaches a comment to the rating the player just gave. */
export async function saveComment(gameId: string, playerId: string, comment: string): Promise<void> {
  await query(
    `INSERT INTO game_feedback (game_id, player_id, comment)
     VALUES ($1, $2, $3)
     ON CONFLICT (game_id, player_id) DO UPDATE SET comment = EXCLUDED.comment`,
    [gameId, playerId, comment.slice(0, 2000)],
  );

  // The comment is the part worth reading, so it goes in the summary rather
  // than being hidden in the detail blob.
  void notify({
    trigger: 'feedback.received',
    summary: `Comment: "${comment.slice(0, 160)}"`,
    gameId,
    playerId,
    detail: { comment: comment.slice(0, 2000) },
  });
}

export async function feedbackSummary(): Promise<Record<string, unknown> | null> {
  return queryOne(
    `SELECT count(*)::int AS responses,
            count(rating)::int AS rated,
            round(avg(rating)::numeric, 2) AS average_rating,
            count(comment)::int AS comments
       FROM game_feedback`,
  );
}

export async function listFeedback(limit: number, offset: number): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT f.id, f.created_at, f.rating, f.comment, f.approved_at, f.approved_by, f.display_as,
            g.room_code, p.wa_id, p.display_name
       FROM game_feedback f
       LEFT JOIN games g ON g.id = f.game_id
       JOIN players p ON p.id = f.player_id
      ORDER BY f.created_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
}

/* ---------------------------------------------------------- testimonials */

/**
 * Publishes one piece of feedback on the marketing site.
 *
 * The name is captured now rather than joined later: a player who changes their
 * WhatsApp profile name has not agreed to the new one appearing on a public
 * page, and a testimonial that quietly rewrites itself is worse than a stale
 * one. An operator can also override the name here — plenty of profile names
 * are a full legal name, and "Amruta" is the right thing to print.
 */
export async function approveFeedback(
  id: string,
  by: string,
  displayAs?: string | null,
): Promise<Record<string, unknown> | null> {
  return queryOne(
    `UPDATE game_feedback f
        SET approved_at = now(),
            approved_by = $2,
            display_as  = COALESCE($3, NULLIF(TRIM(SPLIT_PART(
              (SELECT COALESCE(p.display_name, 'A player') FROM players p WHERE p.id = f.player_id),
              ' ', 1)), ''), 'A player')
      WHERE f.id = $1
      RETURNING id, approved_at, approved_by, display_as`,
    [id, by, displayAs ?? null],
  );
}

/** Takes it back off the site. The feedback itself is never deleted. */
export async function unapproveFeedback(id: string): Promise<void> {
  await query(
    'UPDATE game_feedback SET approved_at = NULL, approved_by = NULL WHERE id = $1',
    [id],
  );
}

/**
 * What the marketing site shows.
 *
 * No phone number, no player id, no room code — nothing that identifies anybody
 * beyond the first name an operator approved. Empty comments are excluded: a
 * bare five stars is not a testimonial, it is a number.
 */
export async function listTestimonials(limit = 12): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT f.display_as AS name, f.rating, f.comment, f.approved_at
       FROM game_feedback f
      WHERE f.approved_at IS NOT NULL
        AND COALESCE(TRIM(f.comment), '') <> ''
      ORDER BY f.approved_at DESC
      LIMIT $1`,
    [limit],
  );
}
