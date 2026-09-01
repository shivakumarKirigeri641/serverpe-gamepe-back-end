import { env, isChargingEnabled, trialEndLabel } from './config/env.js';
import { logger } from './utils/logger.js';
import { registerAllGames } from './games/index.js';
import { runMigrations } from './db/migrate.js';
import { loadSettings } from './services/settings.service.js';
import { ensureUploadFolders } from './services/document.service.js';
import { pool } from './db/pool.js';
import { redis } from './redis/client.js';
import { startServer } from './http/server.js';
import { createDrawWorker } from './workers/draw.worker.js';
import { createMaintenanceWorker } from './workers/maintenance.worker.js';
import { drawQueue, maintenanceQueue, scheduleDigest, scheduleMaintenance } from './workers/queue.js';

/**
 * The one line a human reads when starting the server.
 *
 * The structured log above is for journald and for grep; it is also a wall of
 * JSON, and "did it actually come up?" should not require reading JSON at 2am.
 * This prints the two facts that matter — it is listening, and on what — plus
 * the settings that are dangerous to be wrong about without noticing.
 *
 * Written straight to stdout rather than through the logger, so it survives
 * whatever log level is set and shows up the same under npm start, pm2 and
 * systemd.
 */
function banner(): void {
  const tick = '✅';
  const url = `http://127.0.0.1:${env.PORT}${env.API_BASE_PATH}`;

  const notes: string[] = [];
  if (env.NODE_ENV !== 'production') notes.push(`env ${env.NODE_ENV}`);
  if (!isChargingEnabled()) notes.push(`free until ${trialEndLabel()}`);
  if (env.WHATSAPP_ALLOWED_RECIPIENTS.trim() !== '') {
    notes.push(`ONLY messaging ${env.WHATSAPP_ALLOWED_RECIPIENTS.split(',').length} test number(s)`);
  }
  if (env.PAYMENT_TEST_MENU) notes.push('test-payment menu ON');

  process.stdout.write(
    `\n${tick}  ${env.BRAND_NAME} running on port ${env.PORT}\n` +
      `   ${url}/public/health\n` +
      (notes.length ? `   ${notes.join('  ·  ')}\n` : '') +
      '\n',
  );
}

async function main(): Promise<void> {
  registerAllGames();

  const ran = await runMigrations();
  if (ran.length) logger.info({ ran }, 'database migrated');

  // After the migrations, before anything serves: an operator-set trial date
  // must be in force for the very first message, not from the second restart.
  await loadSettings();

  const server = startServer();

  // Single-process for now: the API and the draw worker share a runtime. Split
  // them by running `npm run worker` separately once traffic justifies it.
  const worker = createDrawWorker();
  const maintenance = createMaintenanceWorker();
  // Created up front so the first report of a fresh deployment does not fail
  // on a missing directory.
  await ensureUploadFolders();
  await scheduleMaintenance();
  await scheduleDigest();

  logger.info(
    {
      env: env.NODE_ENV,
      drawIntervalSeconds: env.DRAW_INTERVAL_SECONDS,
      flowConfigured: Boolean(env.WHATSAPP_FLOW_ID),
      charging: env.MONETIZATION_ENABLED,
      adminApi: env.ADMIN_API_KEY ? 'enabled' : 'disabled (set ADMIN_API_KEY)',
      messageRetentionDays: env.MESSAGE_BODY_RETENTION_DAYS,
    },
    'gamepe ready',
  );

  banner();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    server.close();
    await worker.close();
    await maintenance.close();
    await drawQueue.close();
    await maintenanceQueue.close();
    await redis.quit();
    await pool.end();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'failed to start');
  process.exit(1);
});
