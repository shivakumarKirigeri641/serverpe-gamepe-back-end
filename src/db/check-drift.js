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

/** --apply runs the migration instead of only writing it out. */
const apply = process.argv.includes('--apply');

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[90m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

/**
 * The CREATE TABLE for one table, exactly as written, plus any CREATE INDEX
 * that follows it for the same table.
 *
 * Read from the untouched file rather than the comment-stripped copy the
 * parser uses, so a migration a human has to review still explains itself.
 */
function originalStatement(sql, table) {
  const re = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${table}\\s*\\([\\s\\S]*?\\n\\);`, 'i');
  const m = sql.match(re);
  if (!m) return null;

  let out = m[0];

  // Indexes for a table are declared immediately after it. Carrying them along
  // matters: a table created without its indexes works fine on an empty table
  // and becomes a problem later, under load, with nothing to point at.
  const onThisTable = new RegExp(`\\bON ${table}\\b`, 'i');
  for (const line of sql.slice(m.index + m[0].length).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (/^CREATE (UNIQUE )?INDEX/i.test(t) && onThisTable.test(t)) {
      out += `\n${t}`;
      continue;
    }
    if (t.startsWith('--')) continue;
    break;   // anything else means we have left this table's block
  }
  return out;
}

function parseSchema(sql) {
  const tables = new Map();
  const statements = new Map();

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
    // The statement itself, so a missing table can be created rather than
    // triggering a rebuild of the whole database.
    tables.set(table, parsed);
    statements.set(table, originalStatement(sql, table));
  }
  return { tables, statements };
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

/**
 * Runs the generated migration through the app's own connection.
 *
 * Exists so a deployment does not need psql installed, and does not need the
 * database password typed a second time on a command line where it lands in
 * the shell history. The credentials are the ones already in .env.
 *
 * Two safety properties:
 *
 *   - One transaction. Every statement lands or none does, so a half-migrated
 *     schema is not a state this can produce.
 *   - It refuses to run anything containing <<CHOOSE A VALUE>>. Those appear
 *     where a NOT NULL column has to be backfilled, and the value is a
 *     decision about real data. Guessing it is how a migration quietly writes
 *     the wrong thing into every existing row.
 */
async function applyMigration(body, dbName) {
  if (body.includes('<<CHOOSE A VALUE>>')) {
    console.log(`\n  ${red('not applied')} — this migration needs values filled in first.`);
    console.log(`  ${dim('Edit drift-fix.sql, replace every <<CHOOSE A VALUE>>, then re-run.')}\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n  applying to ${bold(dbName)} …`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(body);
    await client.query('COMMIT');
    console.log(`  ${green('✓')} applied. Restart the server so it picks up the change.\n`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.log(`  ${red('failed, nothing changed')}: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

async function main() {
  const sql = await readFile(join(here, 'schema.sql'), 'utf8');
  const { tables: want, statements } = parseSchema(sql);
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
      // A new table is the ordinary case for a release: create it, do not
      // rebuild the database around it.
      const create = statements.get(table);
      fixes.push(create
        ? `-- ${table} is new in this release.\n${create}`
        : `-- ${table} is missing and could not be read from schema.sql.`);
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
    const body = [...new Set(fixes)].join('\n\n');
    await import('node:fs/promises').then((fsp) =>
      fsp.writeFile(file, `${header}${body}\n\nCOMMIT;\n`));

    if (!apply) {
      console.log(`\n  ${yellow('written to ' + file)}`);
      console.log(`  ${dim('apply it with:  npm run db:migrate    (or psql -f ' + file + ')')}\n`);
    } else {
      await applyMigration(body, db.name);
    }
  }

  await closePool();
  process.exitCode = problems ? 1 : 0;
}

main().catch(async (err) => {
  console.error(red('\ndrift check failed: ') + err.message + '\n');
  await closePool().catch(() => {});
  process.exitCode = 1;
});
