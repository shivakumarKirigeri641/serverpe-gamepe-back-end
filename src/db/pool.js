/**
 * The one and only Postgres pool.
 *
 * Every query in the app goes through here. A pool - never a client per
 * request - is what keeps the app upright when fifty players tap a button in
 * the same second: connections are reused instead of renegotiated, and the
 * pool caps how many can ever be in flight.
 */
import pg from 'pg';
import { config } from '../config/env.js';
import { log } from '../utils/logger.js';

// bigserial columns come back as strings by default because a JS number cannot
// hold the whole int8 range. Our ids never get near that, and strings-vs-numbers
// mismatches are a nasty source of bugs, so parse them.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // A runaway query must not be allowed to hold a connection forever and
  // starve the pool during a live game.
  statement_timeout: 10_000,
});

pool.on('error', (err) => {
  log.error('idle postgres client errored', { message: err.message });
});

/** Shorthand for a one-off query. */
export function query(text, params) {
  return pool.query(text, params);
}

/**
 * Runs fn inside a transaction, committing on success and rolling back on any
 * throw. The client is always released, including when the rollback itself
 * fails - a leaked client is worse than a lost error.
 *
 * Use this for anything that takes a row lock: drawing a number, awarding a
 * prize, seating a player.
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      log.error('rollback failed', { message: rollbackErr.message });
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Postgres unique-violation. The claim race and the join race both rely on it. */
export const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err) {
  return err && err.code === UNIQUE_VIOLATION;
}

/** Confirms the database is reachable, and says so usefully when it is not. */
export async function assertConnection() {
  try {
    const { rows } = await pool.query('SELECT current_database() AS db, version() AS version');
    log.info('postgres connected', {
      database: rows[0].db,
      host: `${config.db.host}:${config.db.port}`,
      version: rows[0].version.split(' ').slice(0, 2).join(' '),
    });
  } catch (err) {
    log.error('cannot reach postgres', {
      host: `${config.db.host}:${config.db.port}`,
      database: config.db.database,
      user: config.db.user,
      message: err.message,
    });
    throw err;
  }
}

export async function closePool() {
  await pool.end();
}
