import { query, withTransaction } from '../db/pool.js';
import { redis } from '../redis/client.js';
import { drawQueue } from '../workers/queue.js';
import { purgeDocuments } from './document.service.js';
import { logger } from '../utils/logger.js';

/**
 * Wipes every record of a person or a game, and keeps the reference data.
 *
 * Testing a WhatsApp product fills the database with people who do not exist:
 * fixture numbers, half-finished rooms, consent rows for players nobody ever
 * messaged. Left there they poison the analytics and make a real signup hard to
 * spot. This clears them out in one action.
 *
 * What survives is the configuration that was seeded rather than earned —
 * the legal documents, the plans and their prices, the company details, and the
 * migration ledger. Wiping those would mean re-seeding the policies before the
 * bot could legally reply to anybody, which is never what "clean up the test
 * data" means.
 *
 * The keep-list is explicit and the wipe-list is derived from it, so a table
 * added by a future migration is cleared by default rather than quietly
 * accumulating rows nobody remembers to delete. Anything new that is genuinely
 * reference data has to be named here — a deliberate step, at the one moment
 * somebody is looking at exactly this question.
 */
const KEEP = [
  'schema_migrations',
  'business_profile',
  'legal_documents',
  'plans',
] as const;

export interface PurgePreview {
  keep: { table: string; rows: number }[];
  wipe: { table: string; rows: number }[];
  totalRows: number;
  redisKeys: number;
}

async function dataTables(): Promise<string[]> {
  const rows = await query<{ table_name: string }>(
    `SELECT c.relname AS table_name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY 1`,
  );
  return rows.map((r) => r.table_name).filter((t) => !KEEP.includes(t as (typeof KEEP)[number]));
}

async function countRows(tables: readonly string[]): Promise<{ table: string; rows: number }[]> {
  const out: { table: string; rows: number }[] = [];
  for (const table of tables) {
    // Table names come from the catalogue, never from the request, so the
    // identifier is safe to interpolate — and it has to be, since an identifier
    // cannot be a bind parameter.
    const [row] = await query<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}"`);
    out.push({ table, rows: Number(row?.n ?? 0) });
  }
  return out;
}

/** What a purge would remove, so nobody has to run it to find out. */
export async function previewPurge(): Promise<PurgePreview> {
  const wipeTables = await dataTables();
  const [wipe, keep] = await Promise.all([countRows(wipeTables), countRows(KEEP)]);

  return {
    keep,
    wipe: wipe.filter((t) => t.rows > 0),
    totalRows: wipe.reduce((sum, t) => sum + t.rows, 0),
    redisKeys: (await redis.keys('*')).length,
  };
}

export interface PurgeResult {
  filesDeleted: number;
  tablesCleared: number;
  rowsDeleted: number;
  redisKeysDeleted: number;
  drawJobsDropped: number;
  keptTables: string[];
}

/**
 * Performs the purge.
 *
 * Redis is cleared too, and that is not tidiness: it holds queued draw jobs for
 * games that are about to stop existing and webhook de-duplication ids for
 * deleted messages. Leaving them means a worker waking up to play a game whose
 * rows are gone, and a replayed webhook being silently discarded as a duplicate
 * of a message that no longer exists.
 */
export async function purgeData(performedBy: string): Promise<PurgeResult> {
  const tables = await dataTables();
  const before = await countRows(tables);
  const rowsDeleted = before.reduce((sum, t) => sum + t.rows, 0);

  // Drained before the rows go, so no worker can pick up a job mid-truncate and
  // find the game half-deleted.
  const drawJobsDropped = (await drawQueue.getJobCountByTypes('delayed', 'waiting', 'active')) || 0;
  await drawQueue.obliterate({ force: true }).catch((err: unknown) => {
    logger.warn({ err }, 'could not obliterate draw queue during purge');
  });

  // Files first: once the rows go, nothing knows where the PDFs are, and the
  // uploads folder would keep reports for games that no longer exist.
  const filesDeleted = await purgeDocuments();

  await withTransaction(async (client) => {
    const list = tables.map((t) => `"${t}"`).join(', ');
    await client.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  });

  // Scanned rather than KEYS-globbed: this runs against whatever Redis the
  // operator is pointed at, and a blocking full-keyspace read is a bad habit to
  // ship even when the keyspace is small.
  let redisKeysDeleted = 0;
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', '*', 'COUNT', 500);
    cursor = next;
    if (batch.length) {
      await redis.del(...batch);
      redisKeysDeleted += batch.length;
    }
  } while (cursor !== '0');

  logger.warn(
    { performedBy, rowsDeleted, tables: tables.length, redisKeysDeleted },
    'admin purged all player and game data',
  );

  return {
    filesDeleted,
    tablesCleared: tables.length,
    rowsDeleted,
    redisKeysDeleted,
    drawJobsDropped,
    keptTables: [...KEEP],
  };
}
