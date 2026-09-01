import { query, queryOne } from '../db/pool.js';

/**
 * The host's-eye view of the platform.
 *
 * Everything else in the admin panel is organised by player or by game, and
 * neither answers the question this product is actually run on: who is putting
 * games together, how often, and who do they bring with them. A host is not a
 * separate kind of account — anybody who opens a room is one, and hosts play as
 * ordinary players in other people's rooms — so this is a view over the same
 * tables rather than a new record type.
 *
 * Phone numbers appear here because this is the admin panel, which is the one
 * place they are allowed to: never in a report, never on a board, never to
 * another player.
 */

export interface HostSummary {
  id: string;
  wa_id: string;
  display_name: string | null;
  games_hosted: number;
  games_completed: number;
  games_abandoned: number;
  players_brought: number;
  distinct_players: number;
  first_hosted_at: string | null;
  last_hosted_at: string | null;
  games_as_guest: number;
  prizes_won: number;
  created_at: string;
  last_seen_at: string;
}

/**
 * Everyone who has ever opened a room, most recent first.
 *
 * `players_brought` counts every seat across their games and `distinct_players`
 * the people behind those seats — the gap between the two is repeat attendance,
 * which is what says whether a host has a circle or threw one party.
 */
export async function listHosts(
  limit: number,
  offset: number,
  search?: string,
): Promise<HostSummary[]> {
  return query<HostSummary>(
    `WITH hosted AS (
       SELECT g.host_player_id AS player_id,
              count(*)                                       AS games_hosted,
              count(*) FILTER (WHERE g.status = 'completed')  AS games_completed,
              count(*) FILTER (WHERE g.status = 'cancelled')  AS games_abandoned,
              min(g.created_at)                               AS first_hosted_at,
              max(g.created_at)                               AS last_hosted_at
         FROM games g
        WHERE g.host_player_id IS NOT NULL
        GROUP BY g.host_player_id
     ),
     brought AS (
       SELECT g.host_player_id AS player_id,
              count(e.id)                 AS players_brought,
              count(DISTINCT e.player_id) AS distinct_players
         FROM games g
         JOIN game_entries e ON e.game_id = g.id
        WHERE g.host_player_id IS NOT NULL
        GROUP BY g.host_player_id
     ),
     guest AS (
       SELECT e.player_id, count(*) AS games_as_guest
         FROM game_entries e
         JOIN games g ON g.id = e.game_id
        WHERE g.host_player_id IS DISTINCT FROM e.player_id
        GROUP BY e.player_id
     )
     SELECT p.id, p.wa_id, p.display_name, p.created_at, p.last_seen_at,
            h.games_hosted, h.games_completed, h.games_abandoned,
            h.first_hosted_at, h.last_hosted_at,
            COALESCE(b.players_brought, 0)  AS players_brought,
            COALESCE(b.distinct_players, 0) AS distinct_players,
            COALESCE(gu.games_as_guest, 0)  AS games_as_guest,
            COALESCE(s.prizes_won, 0)       AS prizes_won
       FROM hosted h
       JOIN players p           ON p.id = h.player_id
       LEFT JOIN brought b      ON b.player_id = h.player_id
       LEFT JOIN guest gu       ON gu.player_id = h.player_id
       LEFT JOIN player_stats s ON s.player_id = h.player_id
      WHERE ($3::text IS NULL
             OR p.wa_id ILIKE '%' || $3 || '%'
             OR p.display_name ILIKE '%' || $3 || '%')
      ORDER BY h.last_hosted_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset, search ?? null],
  );
}

/** How many hosts exist in total, for the page counter. */
export async function countHosts(search?: string): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `SELECT count(DISTINCT g.host_player_id)::text AS n
       FROM games g
       JOIN players p ON p.id = g.host_player_id
      WHERE g.host_player_id IS NOT NULL
        AND ($1::text IS NULL
             OR p.wa_id ILIKE '%' || $1 || '%'
             OR p.display_name ILIKE '%' || $1 || '%')`,
    [search ?? null],
  );
  return Number(row?.n ?? 0);
}

/**
 * One host, and every room they have run.
 *
 * Each game carries its people and what each of them claimed, because that is
 * the shape of the question actually asked — "what happened in that room" —
 * and answering it from three separate pages is how detail gets missed.
 */
export async function getHostDetail(playerId: string): Promise<Record<string, unknown> | null> {
  const host = await queryOne(
    `SELECT p.id, p.wa_id, p.display_name, p.locale, p.is_blocked,
            p.created_at, p.last_seen_at, p.last_region, p.last_city,
            COALESCE(s.games_played, 0)  AS games_played,
            COALESCE(s.prizes_won, 0)    AS prizes_won,
            COALESCE(w.balance_paise, 0) AS balance_paise
       FROM players p
       LEFT JOIN player_stats s ON s.player_id = p.id
       LEFT JOIN wallets w      ON w.player_id = p.id
      WHERE p.id = $1`,
    [playerId],
  );
  if (!host) return null;

  const games = await query(
    `SELECT g.id, g.room_code, g.status, g.game_key,
            g.created_at, g.started_at, g.ended_at,
            g.expected_players, g.plan_key, g.plan_price_paise,
            CASE WHEN g.started_at IS NOT NULL AND g.ended_at IS NOT NULL
                 THEN round(extract(epoch FROM g.ended_at - g.started_at) / 60)::int
            END AS minutes,
            (SELECT count(*) FROM game_entries e WHERE e.game_id = g.id) AS players,
            (SELECT count(*) FROM game_draws d  WHERE d.game_id = g.id)  AS numbers_called,
            (SELECT count(*) FROM game_claims c
              WHERE c.game_id = g.id AND c.status = 'awarded')           AS prizes_awarded,
            (SELECT count(*) FROM game_claims c
              WHERE c.game_id = g.id AND c.status = 'rejected')          AS claims_rejected
       FROM games g
      WHERE g.host_player_id = $1
      ORDER BY g.created_at DESC
      LIMIT 100`,
    [playerId],
  );

  // Everyone who has ever sat in one of this host's rooms, with what they won.
  const players = await query(
    `SELECT pl.id, pl.wa_id, pl.display_name,
            count(DISTINCT e.game_id) AS games_with_host,
            min(g.created_at)         AS first_played_at,
            max(g.created_at)         AS last_played_at,
            count(c.id) FILTER (WHERE c.status = 'awarded')  AS prizes_won,
            count(c.id) FILTER (WHERE c.status = 'rejected') AS claims_rejected,
            -- A guest who has hosted elsewhere is a host in the making, and
            -- that crossover is the growth signal worth seeing on this page.
            (SELECT count(*) FROM games g2 WHERE g2.host_player_id = pl.id) AS games_they_hosted
       FROM game_entries e
       JOIN games g    ON g.id = e.game_id
       JOIN players pl ON pl.id = e.player_id
       LEFT JOIN game_claims c ON c.game_id = g.id AND c.player_id = pl.id
      WHERE g.host_player_id = $1
      GROUP BY pl.id, pl.wa_id, pl.display_name
      ORDER BY count(DISTINCT e.game_id) DESC, max(g.created_at) DESC`,
    [playerId],
  );

  // When each role began: the two dates that say how somebody arrived.
  const roles = await queryOne(
    `SELECT (SELECT min(g.created_at) FROM games g WHERE g.host_player_id = $1)
              AS first_hosted_at,
            (SELECT min(g.created_at) FROM game_entries e JOIN games g ON g.id = e.game_id
              WHERE e.player_id = $1 AND g.host_player_id IS DISTINCT FROM $1)
              AS first_played_as_guest_at,
            (SELECT count(*) FROM game_entries e JOIN games g ON g.id = e.game_id
              WHERE e.player_id = $1 AND g.host_player_id IS DISTINCT FROM $1)
              AS games_as_guest`,
    [playerId],
  );

  return { host, roles, games, players };
}

/**
 * Everything that happened inside one room, in order.
 *
 * The numbers as they were called, the claims as they landed, the joins as
 * they arrived — so a disputed game can be reconstructed rather than argued
 * about.
 */
export async function getGameTimeline(
  gameId: string,
  limit = 400,
): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT * FROM (
       SELECT d.drawn_at AS at, 'draw' AS kind,
              ('called ' || d.value || '  (#' || d.seq || ')') AS detail,
              NULL::uuid AS player_id, NULL::text AS player_name
         FROM game_draws d
        WHERE d.game_id = $1
       UNION ALL
       SELECT c.created_at, 'claim',
              (c.claim_type || ' ' || c.status || COALESCE(' — ' || c.reason, '')),
              c.player_id, p.display_name
         FROM game_claims c
         JOIN players p ON p.id = c.player_id
        WHERE c.game_id = $1
       UNION ALL
       SELECT e.created_at, 'join', 'joined the room', e.player_id, p.display_name
         FROM game_entries e
         JOIN players p ON p.id = e.player_id
        WHERE e.game_id = $1
     ) t
     ORDER BY at ASC
     LIMIT $2`,
    [gameId, limit],
  );
}
