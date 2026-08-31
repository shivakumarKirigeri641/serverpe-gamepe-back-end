import { query, queryOne } from '../db/pool.js';

/**
 * Real-time and comparative views for the admin panel.
 *
 * Kept apart from reporting.service because these queries deliberately read the
 * live tables rather than the daily rollups — a monitoring screen that is five
 * minutes stale is not monitoring.
 */

/* ------------------------------------------------------------------- live */

export async function getLiveSnapshot(): Promise<Record<string, unknown>> {
  const [counts, games, recent] = await Promise.all([
    queryOne<Record<string, string>>(`
      SELECT
        (SELECT count(*) FROM games WHERE status = 'running')                             AS games_running,
        (SELECT count(*) FROM games WHERE status = 'lobby')                               AS games_in_lobby,
        (SELECT count(DISTINCT gp.player_id) FROM game_players gp JOIN games g ON g.id = gp.game_id
          WHERE g.status = 'running' AND gp.left_at IS NULL)                              AS players_in_game,
        (SELECT count(DISTINCT gp.player_id) FROM game_players gp JOIN games g ON g.id = gp.game_id
          WHERE g.status = 'lobby' AND gp.left_at IS NULL)                                AS players_waiting,
        (SELECT count(*) FROM players WHERE last_seen_at > now() - interval '5 minutes')  AS active_5m,
        (SELECT count(*) FROM players WHERE last_seen_at > now() - interval '1 hour')     AS active_1h,
        (SELECT count(*) FROM analytics_events
          WHERE event_type IN ('player.created','player.returned')
            AND occurred_at > now() - interval '1 hour')                                  AS said_hi_1h,
        (SELECT count(*) FROM message_log
          WHERE created_at > now() - interval '1 hour' AND direction = 'outbound')        AS sent_1h,
        (SELECT count(*) FROM message_log
          WHERE created_at > now() - interval '1 hour' AND failed_at IS NOT NULL)         AS failed_1h,
        (SELECT count(*) FROM support_tickets WHERE status NOT IN ('resolved','closed'))  AS tickets_open
    `),
    // Every live room, with who is hosting and how far along it is.
    query(`
      SELECT g.id, g.room_code, g.status, g.started_at, g.expected_players, g.plan_key,
             hp.wa_id AS host_wa_id, COALESCE(hp.display_name, 'Host') AS host_name,
             (SELECT count(*)::int FROM game_players gp
               WHERE gp.game_id = g.id AND gp.left_at IS NULL)                AS players,
             (SELECT count(*)::int FROM game_draws d WHERE d.game_id = g.id)  AS numbers_drawn,
             (SELECT d.value FROM game_draws d WHERE d.game_id = g.id
               ORDER BY d.seq DESC LIMIT 1)                                   AS last_number,
             (SELECT max(d.drawn_at) FROM game_draws d WHERE d.game_id = g.id) AS last_draw_at,
             (SELECT count(*)::int FROM game_claims c
               WHERE c.game_id = g.id AND c.status = 'awarded')               AS prizes_awarded
        FROM games g
        LEFT JOIN players hp ON hp.id = g.host_player_id
       WHERE g.status IN ('lobby','running')
       ORDER BY g.created_at DESC
    `),
    // A rolling feed of what people are doing, minus the message chatter that
    // would otherwise drown everything else out.
    query(`
      SELECT e.occurred_at, e.event_type, e.wa_id, e.properties,
             COALESCE(p.display_name, '') AS display_name, g.room_code
        FROM analytics_events e
        LEFT JOIN players p ON p.id = e.player_id
        LEFT JOIN games g   ON g.id = e.game_id
       WHERE e.occurred_at > now() - interval '30 minutes'
         AND e.event_type NOT IN ('message.sent','message.delivered','message.read')
       ORDER BY e.occurred_at DESC
       LIMIT 60
    `),
  ]);

  const numeric: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts ?? {})) numeric[key] = Number(value);

  return { counts: numeric, games, recent };
}

/** Who is in a live room right now, host first. */
export async function getLivePlayers(): Promise<Record<string, unknown>[]> {
  return query(`
    SELECT p.id, p.wa_id, p.display_name, g.room_code, g.status,
           (g.host_player_id = p.id) AS is_host,
           gp.joined_at,
           (SELECT count(*)::int FROM game_draw_responses r
             WHERE r.game_id = g.id AND r.player_id = p.id)  AS answered,
           (SELECT max(r.responded_at) FROM game_draw_responses r
             WHERE r.game_id = g.id AND r.player_id = p.id)  AS last_answer_at
      FROM game_players gp
      JOIN games g   ON g.id = gp.game_id
      JOIN players p ON p.id = gp.player_id
     WHERE g.status IN ('lobby','running') AND gp.left_at IS NULL
     ORDER BY g.created_at DESC, (g.host_player_id = p.id) DESC, gp.joined_at
  `);
}

/* ------------------------------------------------------------ comparisons */

/**
 * Period-over-period movement.
 *
 * A number on its own says little. The same number against yesterday and last
 * week is what tells you whether anything is working.
 */
export async function getComparisons(): Promise<Record<string, unknown>> {
  const row = await queryOne<Record<string, string>>(`
    SELECT
      (SELECT count(DISTINCT player_id) FROM analytics_events
        WHERE occurred_at::date = current_date AND player_id IS NOT NULL)       AS players_today,
      (SELECT count(DISTINCT player_id) FROM analytics_events
        WHERE occurred_at::date = current_date - 1 AND player_id IS NOT NULL)   AS players_yesterday,
      (SELECT count(*) FROM games WHERE created_at::date = current_date)        AS games_today,
      (SELECT count(*) FROM games WHERE created_at::date = current_date - 1)    AS games_yesterday,
      (SELECT count(*) FROM players WHERE created_at::date = current_date)      AS new_today,
      (SELECT count(*) FROM players WHERE created_at::date = current_date - 1)  AS new_yesterday,
      (SELECT count(*) FROM game_claims
        WHERE status = 'awarded' AND created_at::date = current_date)           AS prizes_today,
      (SELECT count(*) FROM game_claims
        WHERE status = 'awarded' AND created_at::date = current_date - 1)       AS prizes_yesterday,
      (SELECT count(*) FROM games
        WHERE created_at::date > current_date - 7)                              AS games_this_week,
      (SELECT count(*) FROM games
        WHERE created_at::date > current_date - 14
          AND created_at::date <= current_date - 7)                             AS games_last_week,
      (SELECT count(DISTINCT player_id) FROM analytics_events
        WHERE occurred_at::date > current_date - 7 AND player_id IS NOT NULL)   AS players_this_week,
      (SELECT count(DISTINCT player_id) FROM analytics_events
        WHERE occurred_at::date > current_date - 14
          AND occurred_at::date <= current_date - 7
          AND player_id IS NOT NULL)                                            AS players_last_week,
      (SELECT count(*) FROM players WHERE created_at::date > current_date - 7)  AS new_this_week,
      (SELECT count(*) FROM players
        WHERE created_at::date > current_date - 14
          AND created_at::date <= current_date - 7)                             AS new_last_week
  `);

  const n = (key: string): number => Number(row?.[key] ?? 0);

  // Null rather than a fake percentage when there is nothing to compare against
  // — "up 100% from zero" is noise, not a signal.
  const change = (now: number, before: number): number | null => {
    if (before === 0) return now === 0 ? 0 : null;
    return Math.round(((now - before) / before) * 100);
  };

  const pair = (metric: string, now: number, before: number): Record<string, unknown> => ({
    metric,
    now,
    before,
    changePct: change(now, before),
  });

  return {
    daily: [
      pair('Active players', n('players_today'), n('players_yesterday')),
      pair('Games created', n('games_today'), n('games_yesterday')),
      pair('New players', n('new_today'), n('new_yesterday')),
      pair('Prizes won', n('prizes_today'), n('prizes_yesterday')),
    ],
    weekly: [
      pair('Active players', n('players_this_week'), n('players_last_week')),
      pair('Games created', n('games_this_week'), n('games_last_week')),
      pair('New players', n('new_this_week'), n('new_last_week')),
    ],
  };
}

/* ---------------------------------------------------------- conversations */

/**
 * One row per player who has ever messaged, newest activity first.
 *
 * `has_hosted` and `in_game` let the panel split hosts from players without a
 * second round trip.
 */
export async function listConversations(
  limit: number,
  offset: number,
  filter?: 'hosts' | 'players' | 'all',
): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT p.id, p.wa_id, p.display_name, p.created_at, p.last_seen_at, p.is_blocked,
            (SELECT count(*)::int FROM message_log m
              WHERE m.player_id = p.id AND m.direction = 'inbound')  AS received,
            (SELECT count(*)::int FROM message_log m
              WHERE m.player_id = p.id AND m.direction = 'outbound') AS sent,
            (SELECT max(created_at) FROM message_log m WHERE m.player_id = p.id) AS last_message_at,
            EXISTS (SELECT 1 FROM games g WHERE g.host_player_id = p.id) AS has_hosted,
            EXISTS (SELECT 1 FROM games g
                      JOIN game_players gp ON gp.game_id = g.id
                     WHERE gp.player_id = p.id
                       AND g.status IN ('lobby','running')
                       AND gp.left_at IS NULL)                       AS in_game
       FROM players p
      WHERE $3::text IS NULL
         OR $3 = 'all'
         OR ($3 = 'hosts'   AND EXISTS (SELECT 1 FROM games g WHERE g.host_player_id = p.id))
         OR ($3 = 'players' AND NOT EXISTS (SELECT 1 FROM games g WHERE g.host_player_id = p.id))
      ORDER BY COALESCE(
        (SELECT max(created_at) FROM message_log m WHERE m.player_id = p.id),
        p.created_at
      ) DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset, filter ?? null],
  );
}

/** The full back-and-forth with one player. */
export async function getConversation(playerId: string, limit: number): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT m.created_at, m.direction, m.kind, m.status, m.body, m.error,
            m.draw_seq, g.room_code
       FROM message_log m
       LEFT JOIN games g ON g.id = m.game_id
      WHERE m.player_id = $1
      ORDER BY m.created_at DESC
      LIMIT $2`,
    [playerId, limit],
  );
}
