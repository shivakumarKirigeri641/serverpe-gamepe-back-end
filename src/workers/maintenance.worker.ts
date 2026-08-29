import { Worker } from 'bullmq';
import { createQueueConnection } from '../redis/client.js';
import { logger } from '../utils/logger.js';
import { runMaintenance } from '../services/maintenance.service.js';
import { MAINTENANCE_QUEUE } from './queue.js';

/**
 * Housekeeping: cancels abandoned rooms, refreshes the daily rollups and
 * archives aged message bodies. Concurrency 1 - these are whole-table
 * operations and there is no reason to run two at once.
 */
export function createMaintenanceWorker(): Worker {
  const worker = new Worker(
    MAINTENANCE_QUEUE,
    async () => {
      await runMaintenance();
    },
    { connection: createQueueConnection(), concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'maintenance job failed');
  });

  return worker;
}
