import { Worker } from 'bullmq';
import { createQueueConnection } from '../redis/client.js';
import { logger } from '../utils/logger.js';
import { runMaintenance } from '../services/maintenance.service.js';
import { sendDigest } from '../services/notification.service.js';
import { MAINTENANCE_QUEUE } from './queue.js';

/**
 * Housekeeping and the operator digest, routed by job name.
 *
 * Both are periodic and neither is heavy, so they share a queue rather than
 * each having a worker of its own — one fewer connection, one fewer thing to
 * notice has stopped.
 *
 * Concurrency 1: maintenance does whole-table work, and two digests running at
 * once would each claim the same pending events and send the alert twice.
 */
export function createMaintenanceWorker(): Worker {
  const worker = new Worker(
    MAINTENANCE_QUEUE,
    async (job) => {
      if (job.name === 'digest') {
        const result = await sendDigest();
        if (result.sent) {
          logger.info({ events: result.events, to: result.recipient }, 'operator digest sent');
        } else {
          // Not an error: "nothing to report" is the normal case, and logging it
          // at warn would bury the times it genuinely failed.
          logger.debug({ reason: result.reason }, 'digest not sent');
        }
        return;
      }

      await runMaintenance();
    },
    { connection: createQueueConnection(), concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'maintenance job failed');
  });

  return worker;
}
