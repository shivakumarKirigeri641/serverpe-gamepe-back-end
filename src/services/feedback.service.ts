import { query, queryOne } from '../db/pool.js';

/** Ratings and comments players leave after a round. */

export async function saveRating(gameId: string, playerId: string, rating: number): Promise<void> {
  await query(
    `INSERT INTO game_feedback (game_id, player_id, rating)
     VALUES ($1, $2, $3)
     ON CONFLICT (game_id, player_id) DO UPDATE SET rating = EXCLUDED.rating, created_at = now()`,
    [gameId, playerId, rating],
  );
}

/** Attaches a comment to the rating the player just gave. */
export async function saveComment(gameId: string, playerId: string, comment: string): Promise<void> {
  await query(
    `INSERT INTO game_feedback (game_id, player_id, comment)
     VALUES ($1, $2, $3)
     ON CONFLICT (game_id, player_id) DO UPDATE SET comment = EXCLUDED.comment`,
    [gameId, playerId, comment.slice(0, 2000)],
  );
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
    `SELECT f.created_at, f.rating, f.comment, g.room_code, p.wa_id, p.display_name
       FROM game_feedback f
       LEFT JOIN games g ON g.id = f.game_id
       JOIN players p ON p.id = f.player_id
      ORDER BY f.created_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
}
