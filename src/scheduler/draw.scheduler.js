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

const TICK_MS = 1000;
const BATCH = 25;

let timer = null;
let running = false;
let stopping = false;

export function startScheduler() {
  if (timer) return;
  stopping = false;
  timer = setInterval(tick, TICK_MS);
  log.info('draw scheduler started', { everyMs: TICK_MS, drawInterval: config.game.drawIntervalSeconds });
}

export async function stopScheduler() {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = null;
  // Let an in-flight tick finish so a game is not left half-drawn.
  for (let i = 0; running && i < 50; i++) await new Promise((r) => setTimeout(r, 100));
  log.info('draw scheduler stopped');
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
