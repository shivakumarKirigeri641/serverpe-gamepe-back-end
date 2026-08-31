import { logger } from '../utils/logger.js';
import { registerAllGames } from '../games/index.js';
import { createDrawWorker } from './draw.worker.js';

/** Standalone worker process: `npm run worker`. */
registerAllGames();
const worker = createDrawWorker();
logger.info('draw worker started');

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'stopping draw worker');
  await worker.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
