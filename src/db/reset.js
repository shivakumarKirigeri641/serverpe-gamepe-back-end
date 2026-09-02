/**
 * Drops every table and rebuilds from schema.sql.
 *
 *   npm run db:reset              shows what it would destroy, then stops
 *   npm run db:reset -- --yes    rebuilds the tables schema.sql owns
 *   npm run db:reset -- --purge  additionally drops every other table in
 *                                public, clearing out a previous app's leftovers
 *
 * There is no migration chain by design: while the platform is pre-launch,
 * editing one schema file and re-running beats maintaining thirty numbered
 * migrations. It is destructive, so it asks first, every time.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../config/env.js';
import { pool, closePool } from './pool.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(here, 'schema.sql');

const target = `"${config.db.database}" on ${config.db.host}:${config.db.port} as ${config.db.user}`;
const purge = process.argv.includes('--purge');
const confirmed = purge || process.argv.includes('--yes') || process.argv.includes('-y');

/** Tables schema.sql creates, so we can tell ours apart from leftovers. */
const OWNED = new Set([
  'players', 'player_states', 'consents', 'games', 'game_players', 'entries',
  'draws', 'draw_answers', 'claims', 'processed_messages', 'messages', 'feedback',
]);

async function listExistingTables() {
  const { rows } = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  return rows.map((r) => r.tablename);
}

async function main() {
  const existing = await listExistingTables();

  const leftovers = existing.filter((t) => !OWNED.has(t));

  if (!confirmed) {
    console.log(`\nTarget database: ${target}`);
    if (existing.length === 0) {
      console.log('It currently has no tables - nothing would be lost.');
    } else {
      const mine = existing.filter((t) => OWNED.has(t));
      if (mine.length) {
        console.log(`\n--yes will DROP and rebuild ${mine.length} table(s):\n`);
        console.log('  ' + mine.join('\n  '));
      }
      if (leftovers.length) {
        console.log(`\n${leftovers.length} other table(s) are NOT part of this app.`);
        console.log('--yes leaves them alone; --purge drops them too:\n');
        console.log('  ' + leftovers.join('\n  '));
      }
    }
    console.log('\n  npm run db:reset -- --yes      rebuild this app\'s tables');
    console.log('  npm run db:reset -- --purge    also clear the leftovers\n');
    return;
  }

  console.log(`Resetting ${target} ...`);
  const sql = await readFile(SCHEMA_PATH, 'utf8');
  const dropLeftovers = purge && leftovers.length
    ? leftovers.map((t) => `DROP TABLE IF EXISTS "${t}" CASCADE;`).join('\n') + '\n'
    : '';

  if (dropLeftovers) console.log(`Purging ${leftovers.length} leftover table(s) ...`);

  // schema.sql is one unit of work: if any statement fails, the database is
  // left exactly as it was rather than half-rebuilt.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (dropLeftovers) await client.query(dropLeftovers);
    await client.query(sql);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const after = await listExistingTables();
  console.log(`\nDone. ${after.length} tables:\n\n  ` + after.join('\n  ') + '\n');
}

main()
  .catch((err) => {
    console.error('\nReset failed:', err.message);
    if (err.position) console.error(`  at character ${err.position} of schema.sql`);
    process.exitCode = 1;
  })
  .finally(closePool);
