import { env } from '../config/env.js';
import { query, queryOne, withTransaction } from '../db/pool.js';
import { logger } from '../utils/logger.js';
import { EVENT, track } from './analytics.service.js';
import { appDaysAgo, appToday } from '../utils/time.js';

/* ----------------------------------------------------------------- rollups */

/**
 * Recomputes one day's metrics from the raw tables.
 *
 * Idempotent and safe to re-run for any past day — the rollup is a cache, never
 * the source of truth, so a bug here is fixed by recomputing rather than by
 * back-filling.
 */
export async function computeDailyMetrics(day: string): Promise<void> {
  await query(
    `INSERT INTO daily_metrics (
       day, active_players, new_players, returning_players,
       games_created, games_started, games_completed, games_abandoned,
       total_joins, numbers_drawn, acknowledgements,
       claims_awarded, claims_rejected,
       messages_inbound, messages_outbound, messages_failed,
       messages_delivered, messages_read, median_response_ms, computed_at
     )
     SELECT
       $1::date,
       (SELECT count(DISTINCT player_id) FROM analytics_events
         WHERE occurred_at::date = $1 AND player_id IS NOT NULL),
       (SELECT count(*) FROM players WHERE created_at::date = $1),
       (SELECT count(DISTINCT player_id) FROM analytics_events e
         WHERE e.occurred_at::date = $1 AND e.player_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM players p WHERE p.id = e.player_id AND p.created_at::date < $1)),
       (SELECT count(*) FROM games WHERE created_at::date = $1),
       (SELECT count(*) FROM games WHERE started_at::date = $1),
       (SELECT count(*) FROM games WHERE ended_at::date = $1 AND status = 'completed'),
       (SELECT count(*) FROM games WHERE ended_at::date = $1 AND status = 'cancelled'),
       (SELECT count(*) FROM game_players WHERE joined_at::date = $1),
       (SELECT count(*) FROM game_draws WHERE drawn_at::date = $1),
       (SELECT count(*) FROM game_draw_responses WHERE responded_at::date = $1),
       (SELECT count(*) FROM game_claims WHERE created_at::date = $1 AND status = 'awarded'),
       (SELECT count(*) FROM game_claims WHERE created_at::date = $1 AND status = 'rejected'),
       (SELECT count(*) FROM message_log WHERE created_at::date = $1 AND direction = 'inbound'),
       (SELECT count(*) FROM message_log WHERE created_at::date = $1 AND direction = 'outbound'),
       (SELECT count(*) FROM message_log WHERE created_at::date = $1 AND failed_at IS NOT NULL),
       (SELECT count(*) FROM message_log WHERE created_at::date = $1 AND delivered_at IS NOT NULL),
       (SELECT count(*) FROM message_log WHERE created_at::date = $1 AND read_at IS NOT NULL),
       (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ms)::int FROM (
          SELECT EXTRACT(EPOCH FROM (r.responded_at - d.drawn_at)) * 1000 AS ms
            FROM game_draw_responses r
            JOIN game_draws d ON d.game_id = r.game_id AND d.seq = r.seq
           WHERE r.responded_at::date = $1
        ) latencies),
       now()
     ON CONFLICT (day) DO UPDATE SET
       active_players     = EXCLUDED.active_players,
       new_players        = EXCLUDED.new_players,
       returning_players  = EXCLUDED.returning_players,
       games_created      = EXCLUDED.games_created,
       games_started      = EXCLUDED.games_started,
       games_completed    = EXCLUDED.games_completed,
       games_abandoned    = EXCLUDED.games_abandoned,
       total_joins        = EXCLUDED.total_joins,
       numbers_drawn      = EXCLUDED.numbers_drawn,
       acknowledgements   = EXCLUDED.acknowledgements,
       claims_awarded     = EXCLUDED.claims_awarded,
       claims_rejected    = EXCLUDED.claims_rejected,
       messages_inbound   = EXCLUDED.messages_inbound,
       messages_outbound  = EXCLUDED.messages_outbound,
       messages_failed    = EXCLUDED.messages_failed,
       messages_delivered = EXCLUDED.messages_delivered,
       messages_read      = EXCLUDED.messages_read,
       median_response_ms = EXCLUDED.median_response_ms,
       computed_at        = now()`,
    [day],
  );

  await query(
    `INSERT INTO player_daily_activity (player_id, day, messages_sent, games_joined, numbers_answered, prizes_won)
     SELECT p.id, $1::date,
       (SELECT count(*) FROM message_log m
         WHERE m.player_id = p.id AND m.direction = 'inbound' AND m.created_at::date = $1),
       (SELECT count(*) FROM game_players gp WHERE gp.player_id = p.id AND gp.joined_at::date = $1),
       (SELECT count(*) FROM game_draw_responses r WHERE r.player_id = p.id AND r.responded_at::date = $1),
       (SELECT count(*) FROM game_claims c
         WHERE c.player_id = p.id AND c.status = 'awarded' AND c.created_at::date = $1)
     FROM players p
     WHERE EXISTS (
       SELECT 1 FROM analytics_events e
        WHERE e.player_id = p.id AND e.occurred_at::date = $1
     )
     ON CONFLICT (player_id, day) DO UPDATE SET
       messages_sent    = EXCLUDED.messages_sent,
       games_joined     = EXCLUDED.games_joined,
       numbers_answered = EXCLUDED.numbers_answered,
       prizes_won       = EXCLUDED.prizes_won`,
    [day],
  );

  logger.info({ day }, 'daily metrics computed');
  await track({ type: EVENT.ROLLUP_COMPUTED, source: 'worker', properties: { day } });
}

/** Yesterday and today, so the current day is always fresh enough to look at. */
export async function refreshRecentMetrics(): Promise<void> {
  for (const day of [appDaysAgo(1), appToday()]) {
    await computeDailyMetrics(day);
  }
}

/* ----------------------------------------------------------------- archive */

/**
 * Moves message bodies older than the retention window into the archive table
 * and nulls them in the hot table.
 *
 * Content is kept, not destroyed — a dispute about a game months later can
 * still be answered — but it leaves the table that every analytics query
 * touches, and it is in one place if you ever need to purge a player's data.
 */
export async function archiveOldMessageBodies(retentionDays: number, batchSize = 5000): Promise<number> {
  return withTransaction(async (client) => {
    const moved = await client.query<{ id: string }>(
      `WITH aged AS (
         SELECT id, wa_id, direction, body, created_at
           FROM message_log
          WHERE archived_at IS NULL
            AND body IS NOT NULL
            AND created_at < now() - ($1 || ' days')::interval
          ORDER BY created_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       ), inserted AS (
         INSERT INTO message_log_archive (message_log_id, wa_id, direction, body, created_at)
         SELECT id, wa_id, direction, body, created_at FROM aged
         ON CONFLICT (message_log_id) DO NOTHING
         RETURNING message_log_id
       )
       UPDATE message_log m
          SET body = NULL, archived_at = now()
         FROM aged
        WHERE m.id = aged.id
        RETURNING m.id`,
      [String(retentionDays), batchSize],
    );

    const count = moved.rowCount ?? 0;
    if (count > 0) {
      logger.info({ archived: count, retentionDays }, 'archived aged message bodies');
      await track({
        type: EVENT.ARCHIVE_SWEEP,
        source: 'worker',
        properties: { archived: count, retentionDays },
      });
    }
    return count;
  });
}

/* ------------------------------------------------------- abandoned games */

/**
 * Closes rooms nobody is playing.
 *
 * Two cases: a lobby created and never started, and a running game whose
 * players have all stopped answering. Without this, rooms accumulate forever
 * and a player can be stuck "in" a game that will never end.
 */
export async function sweepAbandonedGames(): Promise<{ lobbies: number; stalled: number }> {
  const lobbies = await query<{ id: string; room_code: string }>(
    `UPDATE games
        SET status = 'cancelled', ended_at = now()
      WHERE status = 'lobby'
        AND created_at < now() - ($1 || ' minutes')::interval
      RETURNING id, room_code`,
    [String(env.LOBBY_EXPIRY_MINUTES)],
  );

  // A running game is stalled if no number has been drawn for far longer than
  // the tick interval — which means the worker died or every player left.
  const stalled = await query<{ id: string; room_code: string }>(
    `UPDATE games g
        SET status = 'cancelled', ended_at = now()
      WHERE g.status = 'running'
        AND COALESCE(
              (SELECT max(drawn_at) FROM game_draws d WHERE d.game_id = g.id),
              g.started_at,
              g.created_at
            ) < now() - ($1 || ' minutes')::interval
      RETURNING g.id, g.room_code`,
    [String(env.GAME_STALL_MINUTES)],
  );

  for (const game of [...lobbies, ...stalled]) {
    await track({
      type: EVENT.GAME_ABANDONED,
      source: 'worker',
      gameId: game.id,
      properties: { roomCode: game.room_code, reason: lobbies.includes(game) ? 'lobby_expired' : 'stalled' },
    });
  }

  if (lobbies.length || stalled.length) {
    logger.info({ lobbies: lobbies.length, stalled: stalled.length }, 'swept abandoned games');
  }

  return { lobbies: lobbies.length, stalled: stalled.length };
}

/* ------------------------------------------------------------------ runner */

/** Everything the maintenance job does, in one call. */
export async function runMaintenance(): Promise<void> {
  await sweepAbandonedGames();
  await refreshRecentMetrics();
  await archiveOldMessageBodies(env.MESSAGE_BODY_RETENTION_DAYS);
}

/** Convenience for the admin API's "recompute" endpoint. */
export async function backfillMetrics(fromDay: string, toDay: string): Promise<number> {
  const days = await query<{ day: string }>(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day
       FROM generate_series($1::date, $2::date, '1 day') AS d`,
    [fromDay, toDay],
  );
  for (const { day } of days) {
    await computeDailyMetrics(day);
  }
  return days.length;
}

export async function latestMetricsDay(): Promise<string | null> {
  const row = await queryOne<{ day: string }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day FROM daily_metrics ORDER BY day DESC LIMIT 1`,
  );
  return row?.day ?? null;
}
