import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { query, queryOne, withTransaction, type Queryable } from '../db/pool.js';
import { appDate } from '../utils/time.js';
import { logger } from '../utils/logger.js';

/**
 * Storage for generated PDFs.
 *
 * Reports and invoices are written to disk and indexed in `documents`, so a
 * file that went out over WhatsApp can be found again from the admin panel
 * months later. Building the same PDF a second time would not reproduce it: the
 * player's history has moved on since.
 */

/**
 * Anchored to the working directory, not to this module.
 *
 * Compiled code runs from dist/, so resolving relative to the module would put
 * the files in dist/uploads in production and src/uploads in development — the
 * same server writing to two different folders depending on how it was started.
 * UPLOADS_DIR overrides it when the files belong on a mounted volume.
 */
const UPLOAD_ROOT = resolve(process.env['UPLOADS_DIR'] || join(process.cwd(), 'src', 'uploads'));

export type DocumentKind = 'report' | 'invoice';

const FOLDERS: Record<DocumentKind, string> = {
  report: 'reports',
  invoice: 'invoices',
};

const PREFIXES: Record<DocumentKind, string> = {
  report: 'RPT',
  invoice: 'INV',
};

export function uploadRoot(): string {
  return UPLOAD_ROOT;
}

export function folderFor(kind: DocumentKind): string {
  return join(UPLOAD_ROOT, FOLDERS[kind]);
}

/**
 * Mints the next number for today.
 *
 * Numbering restarts at 1 each IST day, so the day's volume is readable off the
 * last number without opening anything. The upsert increments under a row lock
 * rather than counting rows, because two games finishing in the same second
 * would otherwise both mint the same number and the unique index would reject
 * the second one — losing a report at the exact moment the product is busiest.
 */
export async function nextDocumentNumber(
  kind: DocumentKind,
  on = appDate(),
  client?: Queryable,
): Promise<string> {
  const row = await queryOne<{ last_number: number }>(
    `INSERT INTO document_counters (kind, issued_on, last_number)
          VALUES ($1, $2::date, 1)
     ON CONFLICT (kind, issued_on)
     DO UPDATE SET last_number = document_counters.last_number + 1
       RETURNING last_number`,
    [kind, on],
    client,
  );

  // RPT20260830MP1 — prefix, the day it was issued, brand marker, day sequence.
  return `${PREFIXES[kind]}${on.replace(/-/g, '')}MP${row?.last_number ?? 1}`;
}

export interface StoreDocumentInput {
  kind: DocumentKind;
  buffer: Buffer;
  playerId?: string | null;
  gameId?: string | null;
  waId?: string | null;
  title?: string | null;
  metadata?: Record<string, unknown>;
}

export interface StoredDocument {
  id: string;
  docNumber: string;
  filename: string;
  relPath: string;
  absPath: string;
  bytes: number;
}

/**
 * Writes the PDF to disk and records it.
 *
 * The file is written before the row is inserted: a row pointing at a file that
 * does not exist is a download that fails in the operator's face, while a file
 * with no row is invisible and harmless.
 */
export async function storeDocument(input: StoreDocumentInput): Promise<StoredDocument> {
  const issuedOn = appDate();

  // Number, file and row in one transaction.
  //
  // The counter is incremented under a row lock, so N games finishing together
  // queue behind each other and every one gets a distinct number. Keeping the
  // file write inside the transaction means a failed write rolls the counter
  // back rather than burning a number, and a committed row is always a file
  // that exists.
  return withTransaction(async (client) => {
    const docNumber = await nextDocumentNumber(input.kind, issuedOn, client);
    const filename = `${docNumber}.pdf`;
    const relPath = `${FOLDERS[input.kind]}/${filename}`;
    const absPath = join(UPLOAD_ROOT, FOLDERS[input.kind], filename);

    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, input.buffer);

    const row = await queryOne<{ id: string }>(
      `INSERT INTO documents
         (kind, doc_number, filename, rel_path, byte_size, player_id, game_id, wa_id, title, metadata, issued_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::date)
       RETURNING id`,
      [
        input.kind,
        docNumber,
        filename,
        relPath,
        input.buffer.byteLength,
        input.playerId ?? null,
        input.gameId ?? null,
        input.waId ?? null,
        input.title ?? null,
        JSON.stringify(input.metadata ?? {}),
        issuedOn,
      ],
      client,
    );

    logger.info({ docNumber, kind: input.kind, bytes: input.buffer.byteLength }, 'document stored');

    return {
      id: row!.id,
      docNumber,
      filename,
      relPath,
      absPath,
      bytes: input.buffer.byteLength,
    };
  });
}

export async function listDocuments(
  kind: DocumentKind | undefined,
  limit: number,
  offset: number,
): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT d.id, d.kind, d.doc_number, d.filename, d.byte_size, d.title, d.issued_on,
            d.created_at, d.wa_id, d.metadata,
            p.display_name, g.room_code
       FROM documents d
       LEFT JOIN players p ON p.id = d.player_id
       LEFT JOIN games   g ON g.id = d.game_id
      WHERE $1::text IS NULL OR d.kind = $1
      ORDER BY d.created_at DESC
      LIMIT $2 OFFSET $3`,
    [kind ?? null, limit, offset],
  );
}

/** Totals per kind per day, for the documents screen. */
export async function documentStats(): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT kind, issued_on, count(*)::int AS documents, sum(byte_size)::bigint AS bytes
       FROM documents
      GROUP BY kind, issued_on
      ORDER BY issued_on DESC, kind
      LIMIT 60`,
  );
}

export interface DocumentFile {
  filename: string;
  buffer: Buffer;
}

/** Reads one document back for download. Null when the row or file is gone. */
export async function readDocument(id: string): Promise<DocumentFile | null> {
  const row = await queryOne<{ filename: string; rel_path: string }>(
    `SELECT filename, rel_path FROM documents WHERE id = $1`,
    [id],
  );
  if (!row) return null;

  // Resolved and re-checked against the root: rel_path comes from our own
  // insert, but a path that escapes the uploads folder should never be readable
  // even if a future migration or a hand-edited row introduces one.
  const absPath = resolve(UPLOAD_ROOT, row.rel_path);
  if (!absPath.startsWith(UPLOAD_ROOT)) return null;

  try {
    return { filename: row.filename, buffer: await readFile(absPath) };
  } catch (err) {
    logger.warn({ err, id, path: row.rel_path }, 'document row has no file on disk');
    return null;
  }
}

/**
 * Deletes every stored file and resets the daily counters.
 *
 * Used by the database purge: leaving the PDFs behind after their rows are gone
 * means an uploads folder that only grows, holding reports for games and people
 * that no longer exist.
 */
export async function purgeDocuments(): Promise<number> {
  const rows = await query<{ rel_path: string }>(`SELECT rel_path FROM documents`);

  let removed = 0;
  for (const row of rows) {
    const absPath = resolve(UPLOAD_ROOT, row.rel_path);
    if (!absPath.startsWith(UPLOAD_ROOT)) continue;
    try {
      await unlink(absPath);
      removed += 1;
    } catch {
      // Already gone; the row is about to follow it.
    }
  }

  await withTransaction(async (client) => {
    await client.query(`TRUNCATE documents, document_counters RESTART IDENTITY CASCADE`);
  });

  return removed;
}

/** Makes sure both folders exist on boot, so the first report never fails. */
export async function ensureUploadFolders(): Promise<void> {
  await Promise.all(
    (Object.keys(FOLDERS) as DocumentKind[]).map((kind) =>
      mkdir(folderFor(kind), { recursive: true }),
    ),
  );
}
