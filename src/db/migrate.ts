import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pool, withTransaction } from './pool.js';
import { logger } from '../utils/logger.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Applies every unapplied .sql file in migrations/, in filename order, each in
 * its own transaction. Safe to call on every boot.
 */
export async function runMigrations(): Promise<string[]> {
  await ensureMigrationsTable();

  const applied = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    ran.push(file);
    logger.info({ migration: file }, 'applied migration');
  }

  return ran;
}

/** `npm run migrate` — only when this file is the process entry point. */
const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (invokedDirectly) {
  runMigrations()
    .then(async (ran) => {
      logger.info(ran.length ? { ran } : 'database already up to date');
      await pool.end();
    })
    .catch(async (err) => {
      logger.error({ err }, 'migration failed');
      process.exitCode = 1;
      await pool.end();
    });
}
