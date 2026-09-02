/**
 * Compares the live database against src/db/schema.sql.
 *
 *   node src/db/check-drift.js
 *
 * There is no migration chain in this project: `npm run setup` creates the
 * schema only when the database is empty, and leaves an existing one alone.
 * That is the safe default, but it means a database created months ago can
 * quietly disagree with the code — and the first symptom is a crash at boot,
 * one column at a time.
 *
 * This finds every difference in one pass, and prints the SQL to fix each one.
 * It changes nothing.
 *
 * What it can and cannot see: this reads the CREATE TABLE blocks out of
 * schema.sql with a regex rather than by executing them. That is enough for
 * table and column presence and for NOT NULL, which is what actually breaks
 * inserts. It does not compare indexes, constraints, or defaults — a clean
 * report here means "the code's inserts will work", not "the schemas are
 * byte-identical".
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, closePool } from './pool.js';

const here = dirname(fileURLToPath(import.meta.url));

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[90m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

/** Pulls `table -> [{ name, notNull }]` out of the schema file. */
function parseSchema(sql) {
  const tables = new Map();

  // Comments have to go before anything else looks at this text. A prose
  // comment inside a CREATE TABLE contains commas, and splitting on those
  // first invents columns out of ordinary English words.
  const clean = sql
    .replace(/\/\*[\s\S]*?\*\//g, '')     // block comments
    .replace(/--[^\n]*/g, '');            // line comments, including mid-line

  const re = /CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\);/gi;
  for (const m of clean.matchAll(re)) {
    const [, table, body] = m;
    const columns = [];
    let depth = 0;
    let line = '';

    // Split on commas at depth zero: a CHECK (x IN ('a','b')) contains commas
    // that are not column separators.
    for (const ch of body) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { columns.push(line); line = ''; continue; }
      line += ch;
    }
    columns.push(line);

    const parsed = [];
    for (const raw of columns) {
      const text = raw.replace(/--[^\n]*/g, '').trim();
      if (!text) continue;
      // Table-level constraints are not columns.
      if (/^(PRIMARY KEY|FOREIGN KEY|UNIQUE|CHECK|CONSTRAINT|EXCLUDE)\b/i.test(text)) continue;
      const name = text.match(/^([a-z_][a-z0-9_]*)/i)?.[1];
      if (!name) continue;
      parsed.push({ name, notNull: /\bNOT\s+NULL\b/i.test(text) });
    }
    tables.set(table, parsed);
  }
  return tables;
}

async function liveSchema() {
  const { rows } = await pool.query(`
    SELECT table_name, column_name, is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY table_name, ordinal_position
  `);
  const tables = new Map();
  for (const r of rows) {
    if (!tables.has(r.table_name)) tables.set(r.table_name, []);
    tables.get(r.table_name).push({ name: r.column_name, notNull: r.is_nullable === 'NO' });
  }
  return tables;
}

async function main() {
  const sql = await readFile(join(here, 'schema.sql'), 'utf8');
  const want = parseSchema(sql);
  const have = await liveSchema();

  const { rows: [db] } = await pool.query('SELECT current_database() AS name, version()');
  console.log(`\n${bold('Schema drift')}  ${dim(db.name)}\n`);

  const fixes = [];
  let problems = 0;

  for (const [table, columns] of want) {
    if (!have.has(table)) {
      problems++;
      console.log(`  ${red('missing table')}  ${table}`);
      fixes.push(`-- ${table} does not exist. Easiest fix is a rebuild:\n--   npm run db:reset -- --yes   (DESTROYS ALL DATA)`);
      continue;
    }

    const live = new Map(have.get(table).map((c) => [c.name, c]));
    const wanted = new Map(columns.map((c) => [c.name, c]));

    for (const [name, col] of wanted) {
      const l = live.get(name);
      if (!l) {
        problems++;
        console.log(`  ${red('missing column')} ${table}.${name}`);
        fixes.push(`ALTER TABLE ${table} ADD COLUMN ${name} <type>;   -- see schema.sql for the type`);
      } else if (col.notNull && !l.notNull) {
        problems++;
        console.log(`  ${yellow('nullable here, NOT NULL in schema')}  ${table}.${name}`);
        fixes.push(`ALTER TABLE ${table} ALTER COLUMN ${name} SET NOT NULL;   -- fails if existing rows are null`);
      }
    }

    // The dangerous direction: a column the code never writes, that the
    // database insists on. This is what breaks an INSERT at boot.
    for (const [name, l] of live) {
      if (wanted.has(name)) continue;
      problems++;
      if (l.notNull) {
        console.log(`  ${red('extra NOT NULL column')} ${table}.${name}  ${dim('— inserts that omit it will fail')}`);
        fixes.push(`ALTER TABLE ${table} ALTER COLUMN ${name} DROP NOT NULL;   -- or: ALTER TABLE ${table} DROP COLUMN ${name};`);
      } else {
        console.log(`  ${dim('extra column')} ${table}.${name} ${dim('(nullable — harmless)')}`);
      }
    }
  }

  const extraTables = [...have.keys()].filter((t) => !want.has(t));
  if (extraTables.length) {
    console.log(`\n  ${dim('tables not in schema.sql (left alone): ' + extraTables.join(', '))}`);
  }

  if (!problems) {
    console.log(`  ${green('✓')} every table and column the code needs is present and writable\n`);
  } else {
    console.log(`\n${bold('Suggested SQL')} ${dim('— read each one before running it')}\n`);
    for (const f of [...new Set(fixes)]) console.log('  ' + f.split('\n').join('\n  '));
    console.log('');
  }

  await closePool();
  process.exitCode = problems ? 1 : 0;
}

main().catch(async (err) => {
  console.error(red('\ndrift check failed: ') + err.message + '\n');
  await closePool().catch(() => {});
  process.exitCode = 1;
});
