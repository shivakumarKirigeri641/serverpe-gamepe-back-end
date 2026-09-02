/**
 * Boot: verify the database, start the HTTP server, print what you need to
 * paste into Meta, and shut down cleanly when asked.
 */
import { config } from './config/env.js';
import { log } from './utils/logger.js';
import { assertConnection, closePool } from './db/pool.js';
import { createApp } from './http/server.js';
import { startScheduler, stopScheduler } from './scheduler/draw.scheduler.js';
import { closeAll } from './services/live.service.js';
import { setOutboundRecorder } from './whatsapp/client.js';
import { logOutbound } from './services/player.service.js';
import { loadSettings } from './services/settings.service.js';

function banner() {
  const webhookUrl = `${config.publicRoot}${config.whatsapp.webhookPath}`;
  const lines = [
    '',
    `  ${config.brandName} - listening on http://localhost:${config.port}`,
    `  public root        ${config.publicRoot || '(not set)'}`,
    `  webhook callback   ${webhookUrl}`,
    `  verify token       ${config.whatsapp.verifyToken || '(not set)'}`,
    `  whatsapp           ${config.whatsapp.live ? 'LIVE - real messages will be sent' : 'dry run - outbound messages are logged, not sent'}`,
    '',
  ];

  if (config.whatsapp.live && config.whatsapp.allowedRecipients.length) {
    lines.splice(-1, 0, `  recipient allowlist ${config.whatsapp.allowedRecipients.join(', ')}`, '');
  }
  if (!config.publicBaseUrl) {
    lines.splice(-1, 0, '  ! PUBLIC_BASE_URL is empty. Set it to your ngrok https URL before testing', '');
  }

  console.log(lines.join('\n'));
}

/**
 * Last-resort net. Route handlers are individually wrapped, but a game in
 * progress must not die because of one stray rejection somewhere - players
 * would simply see the board freeze with no explanation. Log it loudly and
 * keep serving.
 */
function installCrashGuards() {
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection - staying up', {
      message: reason?.message ?? String(reason),
      stack: reason?.stack,
    });
  });

  process.on('uncaughtException', (err) => {
    log.error('uncaught exception - staying up', { message: err.message, stack: err.stack });
  });
}

async function main() {
  installCrashGuards();
  await assertConnection();
  await loadSettings();

  // Every outbound WhatsApp message lands in the conversation log with its
  // delivery outcome, so a silent failure is visible in the admin panel.
  setOutboundRecorder(logOutbound);

  const server = createApp().listen(config.port, () => banner());

  startScheduler();

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.error(
        `port ${config.port} is already in use. Stop whatever is on it, or set ` +
          `PORT to something else in .env`,
      );
      process.exit(1);
    }
    throw err;
  });

  // Give in-flight requests a moment to finish rather than cutting a live
  // game off mid-draw.
  const shutdown = (signal) => {
    log.info(`${signal} received, shutting down`);
    closeAll();
    server.close(async () => {
      await stopScheduler();
      await closePool();
      log.info('shutdown complete');
      process.exit(0);
    });
    setTimeout(() => {
      log.warn('forcing exit after 10s');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('failed to start', { message: err.message });
  process.exit(1);
});
