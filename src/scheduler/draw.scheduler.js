/**
 * The thing that makes numbers come out.
 *
 * Every second it asks Postgres which running games are due, using
 * FOR UPDATE SKIP LOCKED. That one clause is why this design scales sideways:
 * start a second app process and the two will divide the games between them
 * rather than both drawing for the same one. No Redis, no queue server.
 *
 * The claim query only reserves the ids. The actual draw happens outside that
 * transaction, in performDraw(), which takes its own lock and re-checks the
 * cursor - so a slow draw never holds the scheduler's lock open.
 */
import { pool } from '../db/pool.js';
import { log } from '../utils/logger.js';
import { config } from '../config/env.js';
import { performDraw } from '../services/round.service.js';
import { sendText } from '../whatsapp/client.js';

const TICK_MS = 1000;
const BATCH = 25;

let timer = null;
let sweepTimer = null;
let running = false;
let stopping = false;

export function startScheduler() {
  if (timer) return;
  stopping = false;
  timer = setInterval(tick, TICK_MS);

  // Stale lobbies change slowly; once a minute is plenty and keeps this off
  // the hot path that draws numbers.
  sweepTimer = setInterval(() => {
    sweepStaleLobbies().catch((err) =>
      log.error('lobby sweep failed', { message: err.message }));
  }, 60_000);
  sweepTimer.unref?.();
  sweepStaleLobbies().catch(() => {});
  log.info('draw scheduler started', { everyMs: TICK_MS, drawInterval: config.game.drawIntervalSeconds });
}

export async function stopScheduler() {
  stopping = true;
  if (timer) clearInterval(timer);
  if (sweepTimer) clearInterval(sweepTimer);
  timer = null;
  sweepTimer = null;
  // Let an in-flight tick finish so a game is not left half-drawn.
  for (let i = 0; running && i < 50; i++) await new Promise((r) => setTimeout(r, 100));
  log.info('draw scheduler stopped');
}

/**
 * Closes lobbies nobody ever started.
 *
 * This is not housekeeping, it is a correctness fix. One player may only be in
 * one active game, and a lobby counts - so a host whose friends never turned
 * up stays attached to that dead room and can NEVER create another game. They
 * would have to guess that "leave" is a command to escape.
 *
 * Runs on its own slow interval; a minute of staleness costs nothing.
 */
async function sweepStaleLobbies() {
  const { rows } = await pool.query(
    `UPDATE games
        SET status = 'abandoned', ended_at = now(), ended_reason = 'abandoned'
      WHERE status = 'lobby'
        AND created_at < now() - make_interval(mins => $1)
      RETURNING id, code, host_player_id`,
    [config.game.lobbyExpiryMinutes],
  );
  if (rows.length === 0) return;

  log.info('expired stale lobbies', {
    count: rows.length,
    afterMinutes: config.game.lobbyExpiryMinutes,
  });

  // Tell each host once, so a room going quiet is explained rather than just
  // vanishing the next time they try to play.
  for (const game of rows) {
    try {
      const { rows: host } = await pool.query('SELECT wa_id FROM players WHERE id = $1', [game.host_player_id]);
      if (host[0]?.wa_id) {
        await sendText(host[0].wa_id,
          `Your game room *${game.code}* has expired — it sat waiting for ` +
          `${config.game.lobbyExpiryMinutes} minutes without starting.\n\n` +
          `Nothing is lost. Type *hi* whenever you want to set up a new one.`);
      }
    } catch (err) {
      log.warn('could not notify host of expired lobby', { gameId: game.id, message: err.message });
    }
  }
}

async function tick() {
  // Overlapping ticks would be harmless - performDraw re-checks everything -
  // but skipping keeps the logs and the connection pool calm.
  if (running || stopping) return;
  running = true;

  try {
    const due = await claimDueGames();
    for (const { id, cursor } of due) {
      if (stopping) break;
      try {
        await performDraw(id, cursor);
      } catch (err) {
        log.error('draw failed', { gameId: id, message: err.message, stack: err.stack });
      }
    }
  } catch (err) {
    log.error('scheduler tick failed', { message: err.message });
  } finally {
    running = false;
  }
}

/**
 * Which games are due right now. The rows are locked only for the instant it
 * takes to read them; SKIP LOCKED means a second process sees a different set
 * instead of blocking.
 */
async function claimDueGames() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, cursor
         FROM games
        WHERE status = 'running' AND next_draw_at <= now()
        ORDER BY next_draw_at
          FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [BATCH],
    );
    await client.query('COMMIT');
    return rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
