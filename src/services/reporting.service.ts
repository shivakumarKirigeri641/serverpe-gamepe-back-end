import { query, queryOne } from '../db/pool.js';
import { appDaysAgo, appToday } from '../utils/time.js';

/**
 * Read-only queries behind the admin API. Everything here is a plain SELECT —
 * no writes, no side effects — so the admin panel can never mutate game state.
 */

export interface DateRange {
  from: string; // YYYY-MM-DD
  to: string;
}

/** Defaults to the last 30 days when the caller supplies nothing. */
export function resolveRange(from?: string, to?: string): DateRange {
  return { from: from ?? appDaysAgo(29), to: to ?? appToday() };
}

/* ---------------------------------------------------------------- overview */

export async function getOverview(): Promise<Record<string, unknown>> {
  const row = await queryOne<Record<string, string>>(`
    SELECT
      (SELECT count(*) FROM players)                                           AS total_players,
      (SELECT count(*) FROM players WHERE created_at::date = current_date)     AS new_players_today,
      (SELECT count(*) FROM players WHERE last_seen_at > now() - interval '24 hours') AS active_24h,
      (SELECT count(*) FROM players WHERE last_seen_at > now() - interval '7 days')   AS active_7d,
      (SELECT count(*) FROM games)                                             AS total_games,
      (SELECT count(*) FROM games WHERE status = 'running')                    AS games_running,
      (SELECT count(*) FROM games WHERE status = 'lobby')                      AS games_in_lobby,
      (SELECT count(*) FROM games WHERE status = 'completed')                  AS games_completed,
      (SELECT count(*) FROM games WHERE status = 'cancelled')                  AS games_abandoned,
      (SELECT count(*) FROM game_claims WHERE status = 'awarded')              AS prizes_awarded,
      (SELECT count(*) FROM message_log WHERE direction = 'inbound')           AS messages_in,
      (SELECT count(*) FROM message_log WHERE direction = 'outbound')          AS messages_out,
      (SELECT count(*) FROM message_log WHERE failed_at IS NOT NULL)           AS messages_failed,
      (SELECT count(*) FROM analytics_events)                                  AS events_recorded
  `);

  const numeric: Record<string, number> = {};
  for (const [key, value] of Object.entries(row ?? {})) numeric[key] = Number(value);
  return numeric;
}

/* ------------------------------------------------------------ time series */

/** One row per day — the shape a line chart wants. */
export async function getDailyMetrics(range: DateRange): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, active_players, new_players, returning_players,
            games_created, games_started, games_completed, games_abandoned, total_joins,
            numbers_drawn, acknowledgements, claims_awarded, claims_rejected,
            messages_inbound, messages_outbound, messages_failed,
            messages_delivered, messages_read, median_response_ms
       FROM daily_metrics
      WHERE day BETWEEN $1::date AND $2::date
      ORDER BY day`,
    [range.from, range.to],
  );
}

/**
 * Acquisition-to-completion funnel. Each step is distinct players, so the
 * drop-off between steps is meaningful rather than a message count.
 */
export async function getFunnel(range: DateRange): Promise<Record<string, number>> {
  const row = await queryOne<Record<string, string>>(
    `SELECT
       (SELECT count(DISTINCT player_id) FROM analytics_events
         WHERE event_type IN ('player.created','player.returned')
           AND occurred_at::date BETWEEN $1 AND $2)                  AS messaged_bot,
       (SELECT count(DISTINCT player_id) FROM analytics_events
         WHERE event_type = 'menu.shown' AND occurred_at::date BETWEEN $1 AND $2) AS saw_menu,
       (SELECT count(DISTINCT player_id) FROM analytics_events
         WHERE event_type = 'game.created' AND occurred_at::date BETWEEN $1 AND $2) AS created_room,
       (SELECT count(DISTINCT player_id) FROM analytics_events
         WHERE event_type = 'game.joined' AND occurred_at::date BETWEEN $1 AND $2) AS joined_room,
       (SELECT count(DISTINCT player_id) FROM analytics_events
         WHERE event_type = 'game.started' AND occurred_at::date BETWEEN $1 AND $2) AS started_game,
       (SELECT count(DISTINCT player_id) FROM analytics_events
         WHERE event_type = 'game.ack' AND occurred_at::date BETWEEN $1 AND $2) AS answered_a_number,
       (SELECT count(DISTINCT player_id) FROM analytics_events
         WHERE event_type = 'claim.awarded' AND occurred_at::date BETWEEN $1 AND $2) AS won_a_prize`,
    [range.from, range.to],
  );

  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(row ?? {})) out[key] = Number(value);
  return out;
}

/**
 * Response-time distribution, bucketed for a histogram. This is the data that
 * answers whether the draw interval is set correctly.
 */
export async function getResponseTimeHistogram(range: DateRange): Promise<Record<string, unknown>[]> {
  return query(
    `WITH latencies AS (
       SELECT EXTRACT(EPOCH FROM (r.responded_at - d.drawn_at)) AS seconds
         FROM game_draw_responses r
         JOIN game_draws d ON d.game_id = r.game_id AND d.seq = r.seq
        WHERE r.responded_at::date BETWEEN $1 AND $2
          AND r.responded_at >= d.drawn_at
     )
     SELECT bucket, count(*)::int AS responses
       FROM (
         SELECT CASE
                  WHEN seconds < 3  THEN '0-3s'
                  WHEN seconds < 5  THEN '3-5s'
                  WHEN seconds < 8  THEN '5-8s'
                  WHEN seconds < 12 THEN '8-12s'
                  WHEN seconds < 20 THEN '12-20s'
                  WHEN seconds < 30 THEN '20-30s'
                  ELSE '30s+'
                END AS bucket
           FROM latencies
       ) b
      GROUP BY bucket
      ORDER BY min(CASE bucket
        WHEN '0-3s' THEN 1 WHEN '3-5s' THEN 2 WHEN '5-8s' THEN 3
        WHEN '8-12s' THEN 4 WHEN '12-20s' THEN 5 WHEN '20-30s' THEN 6 ELSE 7 END)`,
    [range.from, range.to],
  );
}

/** Delivery funnel for outbound messages — accepted vs delivered vs read. */
export async function getDeliveryStats(range: DateRange): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day,
            count(*)::int                                        AS sent,
            count(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered,
            count(*) FILTER (WHERE read_at IS NOT NULL)::int      AS read,
            count(*) FILTER (WHERE failed_at IS NOT NULL)::int    AS failed
       FROM message_log
      WHERE direction = 'outbound' AND created_at::date BETWEEN $1 AND $2
      GROUP BY 1
      ORDER BY 1`,
    [range.from, range.to],
  );
}

/* ----------------------------------------------------------------- players */

export async function listPlayers(
  limit: number,
  offset: number,
  search?: string,
): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT p.id, p.wa_id, p.display_name, p.created_at, p.last_seen_at, p.is_blocked,
            COALESCE(s.games_played, 0) AS games_played,
            COALESCE(s.prizes_won, 0)   AS prizes_won,
            COALESCE(s.points, 0)       AS points
       FROM players p
       LEFT JOIN player_stats s ON s.player_id = p.id
      WHERE ($3::text IS NULL OR p.wa_id ILIKE '%' || $3 || '%' OR p.display_name ILIKE '%' || $3 || '%')
      ORDER BY p.last_seen_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset, search ?? null],
  );
}

export async function getPlayer(playerId: string): Promise<Record<string, unknown> | null> {
  return queryOne(
    `SELECT p.id, p.wa_id, p.display_name, p.locale, p.is_blocked, p.created_at, p.last_seen_at,
            COALESCE(s.games_played, 0) AS games_played,
            COALESCE(s.prizes_won, 0)   AS prizes_won,
            COALESCE(s.full_houses, 0)  AS full_houses,
            COALESCE(s.points, 0)       AS points,
            COALESCE(w.balance_paise, 0) AS balance_paise
       FROM players p
       LEFT JOIN player_stats s ON s.player_id = p.id
       LEFT JOIN wallets w      ON w.player_id = p.id
      WHERE p.id = $1`,
    [playerId],
  );
}

export async function getPlayerActivity(
  playerId: string,
  range: DateRange,
): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, messages_sent, games_joined, numbers_answered, prizes_won
       FROM player_daily_activity
      WHERE player_id = $1 AND day BETWEEN $2::date AND $3::date
      ORDER BY day`,
    [playerId, range.from, range.to],
  );
}

/** Everything a player did, newest first: messages both ways plus events. */
export async function getPlayerTimeline(playerId: string, limit: number): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT * FROM (
       SELECT m.created_at AS at, 'message' AS kind, m.direction, m.kind AS subtype,
              m.status, m.game_id, m.body, NULL::jsonb AS properties
         FROM message_log m WHERE m.player_id = $1
       UNION ALL
       SELECT e.occurred_at, 'event', e.source, e.event_type,
              NULL, e.game_id, NULL::jsonb, e.properties
         FROM analytics_events e WHERE e.player_id = $1
     ) t
     ORDER BY at DESC
     LIMIT $2`,
    [playerId, limit],
  );
}

/* ------------------------------------------------------------------- games */

export async function listGames(
  limit: number,
  offset: number,
  status?: string,
): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT g.id, g.game_key, g.room_code, g.status, g.created_at, g.started_at, g.ended_at,
            g.entry_fee_paise, g.prize_pool_paise, g.is_free_trial,
            hp.wa_id AS host_wa_id, hp.display_name AS host_name,
            (SELECT count(*) FROM game_players gp WHERE gp.game_id = g.id)   AS players,
            (SELECT count(*) FROM game_draws d WHERE d.game_id = g.id)       AS numbers_drawn,
            (SELECT count(*) FROM game_claims c WHERE c.game_id = g.id AND c.status = 'awarded') AS prizes_awarded
       FROM games g
       LEFT JOIN players hp ON hp.id = g.host_player_id
      WHERE ($3::text IS NULL OR g.status = $3)
      ORDER BY g.created_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset, status ?? null],
  );
}

/** Full forensic detail for one game: who, what, when, in order. */
export async function getGameDetail(gameId: string): Promise<Record<string, unknown> | null> {
  const game = await queryOne(
    `SELECT g.*, hp.wa_id AS host_wa_id, hp.display_name AS host_name
       FROM games g LEFT JOIN players hp ON hp.id = g.host_player_id
      WHERE g.id = $1`,
    [gameId],
  );
  if (!game) return null;

  const [players, draws, claims, responses] = await Promise.all([
    query(
      `SELECT gp.player_id, p.wa_id, p.display_name, gp.joined_at, gp.left_at,
              (SELECT count(*) FROM game_entries e WHERE e.game_id = gp.game_id AND e.player_id = gp.player_id) AS entries,
              (SELECT count(*) FROM game_draw_responses r WHERE r.game_id = gp.game_id AND r.player_id = gp.player_id) AS answered
         FROM game_players gp JOIN players p ON p.id = gp.player_id
        WHERE gp.game_id = $1 ORDER BY gp.joined_at`,
      [gameId],
    ),
    query('SELECT seq, value, drawn_at FROM game_draws WHERE game_id = $1 ORDER BY seq', [gameId]),
    query(
      `SELECT c.claim_type, c.status, c.reason, c.draw_seq, c.prize_paise, c.created_at,
              p.wa_id, p.display_name
         FROM game_claims c JOIN players p ON p.id = c.player_id
        WHERE c.game_id = $1 ORDER BY c.created_at`,
      [gameId],
    ),
    query(
      `SELECT r.seq, r.player_id, p.wa_id, r.has_number, r.responded_at,
              EXTRACT(EPOCH FROM (r.responded_at - d.drawn_at)) * 1000 AS latency_ms
         FROM game_draw_responses r
         JOIN players p ON p.id = r.player_id
         JOIN game_draws d ON d.game_id = r.game_id AND d.seq = r.seq
        WHERE r.game_id = $1 ORDER BY r.seq, r.responded_at`,
      [gameId],
    ),
  ]);

  return { game, players, draws, claims, responses };
}

/** Every message exchanged in one room, in order. */
export async function getGameMessages(gameId: string, limit: number): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT m.created_at, m.direction, m.kind, m.status, m.draw_seq, m.wa_id,
            p.display_name, m.body, m.error, m.delivered_at, m.read_at, m.archived_at
       FROM message_log m
       LEFT JOIN players p ON p.id = m.player_id
      WHERE m.game_id = $1
      ORDER BY m.created_at
      LIMIT $2`,
    [gameId, limit],
  );
}

/* ------------------------------------------------------- raw event stream */

export async function listEvents(
  limit: number,
  offset: number,
  filters: { type?: string; playerId?: string; gameId?: string; from?: string; to?: string },
): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT id, occurred_at, event_type, player_id, game_id, wa_id, source, properties,
            host(request_ip) AS request_ip, user_agent, admin_actor
       FROM analytics_events
      WHERE ($3::text IS NULL OR event_type = $3)
        AND ($4::uuid IS NULL OR player_id = $4)
        AND ($5::uuid IS NULL OR game_id = $5)
        AND ($6::date IS NULL OR occurred_at::date >= $6)
        AND ($7::date IS NULL OR occurred_at::date <= $7)
      ORDER BY occurred_at DESC
      LIMIT $1 OFFSET $2`,
    [
      limit,
      offset,
      filters.type ?? null,
      filters.playerId ?? null,
      filters.gameId ?? null,
      filters.from ?? null,
      filters.to ?? null,
    ],
  );
}

export async function getEventTypeCounts(range: DateRange): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT event_type, count(*)::int AS count
       FROM analytics_events
      WHERE occurred_at::date BETWEEN $1 AND $2
      GROUP BY event_type ORDER BY count DESC`,
    [range.from, range.to],
  );
}

/* ------------------------------------------------------------ leaderboard */

export async function getLeaderboard(limit: number): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT p.id, p.wa_id, p.display_name, s.points, s.prizes_won, s.full_houses, s.games_played
       FROM player_stats s JOIN players p ON p.id = s.player_id
      ORDER BY s.points DESC, s.prizes_won DESC
      LIMIT $1`,
    [limit],
  );
}

/* -------------------------------------------------------------- admin log */

export async function listAdminAudit(limit: number, offset: number): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT occurred_at, actor, method, path, status_code, duration_ms,
            host(request_ip) AS request_ip, user_agent, query
       FROM admin_audit_log
      ORDER BY occurred_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
}
