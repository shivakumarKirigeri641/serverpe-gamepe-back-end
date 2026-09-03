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
      // The full text is kept so a missing column can be recreated exactly
      // as schema.sql declares it, types, defaults, checks and all.
      parsed.push({ name, notNull: /\bNOT\s+NULL\b/i.test(text), sql: text.replace(/\s+/g, ' ') });
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

/**
 * Turns a schema.sql column definition into an ALTER that will actually apply.
 *
 * Two adjustments matter on a table that already has rows:
 *
 *   - NOT NULL without a DEFAULT is rejected outright when rows exist, so the
 *     statement is split: add it nullable, backfill, then enforce. The
 *     backfill value has to be a human decision, so it is left as a marked
 *     blank rather than guessed.
 *   - A column with a DEFAULT can be added NOT NULL in one step, because
 *     Postgres fills existing rows from the default.
 */
function addColumnSql(table, col) {
  const body = col.sql;
  const hasDefault = /\bDEFAULT\b/i.test(body);

  if (!col.notNull || hasDefault) {
    return `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${body};`;
  }

  const nullable = body.replace(/\s*\bNOT\s+NULL\b/i, '');
  return [
    `-- ${table}.${col.name} is NOT NULL with no default, so it needs three steps:`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${nullable};`,
    `UPDATE ${table} SET ${col.name} = <<CHOOSE A VALUE>> WHERE ${col.name} IS NULL;`,
    `ALTER TABLE ${table} ALTER COLUMN ${col.name} SET NOT NULL;`,
  ].join('\n');
}

async function main() {
  const sql = await readFile(join(here, 'schema.sql'), 'utf8');
  const want = parseSchema(sql);
  const have = await liveSchema();

  const { rows: [db] } = await pool.query('SELECT current_database() AS name, version()');
  console.log(`\n${bold('Schema drift')}  ${dim(db.name)}\n`);

  const fixes = [];
  const leftovers = [];
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
        fixes.push(addColumnSql(table, col));
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

      // Only a NOT NULL extra is a problem: the code's inserts do not mention
      // the column, so the database rejects them. A nullable leftover is dead
      // weight and nothing more — reporting it as drift would leave this tool
      // permanently unhappy about a database that works perfectly.
      if (l.notNull) {
        problems++;
        console.log(`  ${red('extra NOT NULL column')} ${table}.${name}  ${dim('— inserts that omit it will fail')}`);
        fixes.push(`ALTER TABLE ${table} ALTER COLUMN ${name} DROP NOT NULL;   -- or: ALTER TABLE ${table} DROP COLUMN ${name};`);
      } else {
        leftovers.push(`${table}.${name}`);
      }
    }
  }

  const extraTables = [...have.keys()].filter((t) => !want.has(t));
  if (extraTables.length) {
    console.log(`\n  ${dim('tables not in schema.sql (left alone): ' + extraTables.join(', '))}`);
  }

  if (leftovers.length) {
    console.log('  ' + dim('columns the code no longer uses (nullable, harmless): ' + leftovers.join(', ')));
  }

  if (!problems) {
    console.log(`  ${green('✓')} every table and column the code needs is present and writable\n`);
  } else {
    console.log(`\n${bold('Migration')} ${dim('— read it before running it')}\n`);
    for (const f of [...new Set(fixes)]) console.log('  ' + f.split('\n').join('\n  '));

    // Written out as well, because a migration long enough to matter is one
    // nobody should be reassembling from a terminal scrollback.
    const file = 'drift-fix.sql';
    const header = [
      '-- Generated by: npm run db:check',
      `-- Database: ${db.name}   Generated: ${new Date().toISOString()}`,
      '--',
      '-- Read every statement. Anything marked <<CHOOSE A VALUE>> needs a real',
      '-- value before this will run. Take a backup first:',
      `--   pg_dump -U <user> ${db.name} > backup.sql`,
      '',
      'BEGIN;',
      '',
    ].join('\n');
    await import('node:fs/promises').then((fsp) =>
      fsp.writeFile(file, header + [...new Set(fixes)].join('\n\n') + '\n\nCOMMIT;\n'));
    console.log(`\n  ${yellow('written to ' + file)} — review it, then apply with psql\n`);
  }

  await closePool();
  process.exitCode = problems ? 1 : 0;
}

main().catch(async (err) => {
  console.error(red('\ndrift check failed: ') + err.message + '\n');
  await closePool().catch(() => {});
  process.exitCode = 1;
});
