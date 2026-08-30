import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { registerAllGames } from './games/index.js';
import { runMigrations } from './db/migrate.js';
import { ensureUploadFolders } from './services/document.service.js';
import { pool } from './db/pool.js';
import { redis } from './redis/client.js';
import { startServer } from './http/server.js';
import { createDrawWorker } from './workers/draw.worker.js';
import { createMaintenanceWorker } from './workers/maintenance.worker.js';
import { drawQueue, maintenanceQueue, scheduleDigest, scheduleMaintenance } from './workers/queue.js';

async function main(): Promise<void> {
  registerAllGames();

  const ran = await runMigrations();
  if (ran.length) logger.info({ ran }, 'database migrated');

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
