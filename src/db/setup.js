/**
 * One command to get a fresh machine running:
 *
 *   npm run setup
 *
 * Creates the database if it does not exist, applies the schema if the
 * database is empty, and tells you exactly what to do next.
 *
 * Deliberately SAFE to run twice. It never drops anything: if the tables are
 * already there it says so and stops. Wiping is `npm run db:reset -- --yes`,
 * which is a different command precisely so it cannot happen by accident
 * during a deploy.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { config } from '../config/env.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(here, 'schema.sql');

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[90m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

const step = (n, msg) => console.log(`\n${bold(`[${n}/4]`)} ${msg}`);
const ok = (msg) => console.log(`      ${green('✓')} ${msg}`);
const info = (msg) => console.log(`      ${dim(msg)}`);

/** Connects to the maintenance database, which always exists. */
function adminClient() {
  return new pg.Client({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: 'postgres',
  });
}

function appClient() {
  return new pg.Client({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
  });
}

async function main() {
  console.log(`\n${bold(`${config.brandName} — setup`)}`);
  console.log(dim(`  ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`));

  // ---- 1. reach Postgres -------------------------------------------------
  step(1, 'Connecting to PostgreSQL');
  const admin = adminClient();
  try {
    await admin.connect();
    const { rows } = await admin.query('SELECT version()');
    ok(rows[0].version.split(' ').slice(0, 2).join(' '));
  } catch (err) {
    console.error(`      ${red('✗')} could not connect: ${err.message}\n`);
    console.error('  Check that PostgreSQL is running and that PGHOST, PGPORT,');
    console.error('  PGUSER and PGPASSWORD in .env are correct.\n');
    process.exit(1);
  }

  // ---- 2. create the database -------------------------------------------
  step(2, `Database "${config.db.database}"`);
  const { rows: exists } = await admin.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [config.db.database],
  );

  if (exists.length) {
    ok('already exists');
  } else {
    // The name cannot be parameterised in CREATE DATABASE, so it is quoted as
    // an identifier instead. It comes from .env, not from a request.
    await admin.query(`CREATE DATABASE "${config.db.database.replace(/"/g, '""')}"`);
    ok('created');
  }
  await admin.end();

  // ---- 3. apply the schema ----------------------------------------------
  step(3, 'Schema');
  const app = appClient();
  await app.connect();

  const { rows: tables } = await app.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );

  if (tables.length > 0) {
    ok(`${tables.length} tables already present — leaving them alone`);
    info('to wipe and rebuild:  npm run db:reset -- --yes');
  } else {
    const sql = await readFile(SCHEMA_PATH, 'utf8');
    await app.query('BEGIN');
    try {
      await app.query(sql);
      await app.query('COMMIT');
    } catch (err) {
      await app.query('ROLLBACK').catch(() => {});
      console.error(`      ${red('✗')} schema failed: ${err.message}\n`);
      process.exit(1);
    }
    const { rows: after } = await app.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`,
    );
    ok(`${after[0].n} tables created`);
  }
  await app.end();

  // ---- 4. configuration sanity ------------------------------------------
  step(4, 'Configuration');
  const warnings = [];

  if (!config.publicBaseUrl) {
    warnings.push('PUBLIC_BASE_URL is empty — board links will not work on phones');
  } else if (/localhost|127\.0\.0\.1/.test(config.publicBaseUrl)) {
    warnings.push(
      'PUBLIC_BASE_URL points at localhost — phones cannot reach it. ' +
        'Use your ngrok or production https URL',
    );
  } else {
    ok(`public URL ${config.publicRoot}`);
  }

  if (!config.admin.passcode) warnings.push('ADMIN_PASSCODE is unset — the admin panel cannot be used');
  else ok('admin passcode set');

  if (!config.whatsapp.accessToken) {
    info('WhatsApp is in dry-run mode — outbound messages are logged, not sent');
  } else {
    ok(`WhatsApp live (${config.whatsapp.apiVersion})`);
    if (config.whatsapp.allowedRecipients.length) {
      info(`allowlist: only ${config.whatsapp.allowedRecipients.length} number(s) can receive messages`);
    }
    if (!config.whatsapp.appSecret) warnings.push('WHATSAPP_APP_SECRET is unset — webhook signatures are not verified');
    if (!config.whatsapp.verifyToken) warnings.push('WHATSAPP_VERIFY_TOKEN is unset — Meta cannot verify the webhook');
  }

  if (config.boardLinkSecret === 'dev-insecure-secret') {
    warnings.push('BOARD_LINK_SECRET is the default — set a long random value before going live');
  }

  for (const w of warnings) console.log(`      ${red('!')} ${w}`);

  // ---- next steps --------------------------------------------------------
  console.log(`\n${bold('Ready.')} Start the server with:\n`);
  console.log('  npm start\n');
  console.log(dim('  Webhook callback to paste into Meta:'));
  console.log(dim(`    ${config.publicRoot}${config.whatsapp.webhookPath}`));
  console.log(dim(`  Verify token: ${config.whatsapp.verifyToken || '(unset)'}\n`));

  if (warnings.length) process.exitCode = 0;   // warnings, not failures
}

main().catch((err) => {
  console.error(`\n${red('Setup failed:')} ${err.message}\n`);
  process.exit(1);
});
