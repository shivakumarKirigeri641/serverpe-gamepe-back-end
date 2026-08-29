import { Worker } from 'bullmq';
import { createQueueConnection } from '../redis/client.js';
import { logger } from '../utils/logger.js';
import { runDrawTick } from '../services/round.service.js';
import { DRAW_QUEUE, type DrawJobData } from './queue.js';

/**
 * Drives every running game's tick. Concurrency is per-job, not per-game;
 * `performDraw` re-checks the expected cursor under a row lock, so two workers
 * picking up the timeout job and an early-advance job for the same game cannot
 * both draw.
 */
export function createDrawWorker(): Worker<DrawJobData> {
  const worker = new Worker<DrawJobData>(
    DRAW_QUEUE,
    async (job) => {
      const { gameId, expectedSeq } = job.data;
      await runDrawTick(gameId, expectedSeq);
    },
    { connection: createQueueConnection(), concurrency: 10 },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, gameId: job?.data.gameId, err }, 'draw job failed');
  });

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id, gameId: job.data.gameId }, 'draw job completed');
  });

  return worker;
}
