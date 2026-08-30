import { Queue } from 'bullmq';
import { env } from '../config/env.js';
import { createQueueConnection } from '../redis/client.js';

export const DRAW_QUEUE = 'draw';

export interface DrawJobData {
  gameId: string;
  /** Cursor the game must still be on for this job to be valid. */
  expectedSeq: number;
}

export const drawQueue = new Queue<DrawJobData>(DRAW_QUEUE, {
  connection: createQueueConnection(),
  defaultJobOptions: {
    removeOnComplete: 500,
    removeOnFail: 500,
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  },
});

/**
 * Schedules the next number for a game.
 *
 * The job id is derived from (gameId, expectedSeq) so the timeout job and an
 * early advance triggered by every player answering can never both fire — the
 * second enqueue is a no-op, and `expectedSeq` is re-checked under the row lock
 * before anything is drawn.
 */
export async function scheduleDraw(gameId: string, expectedSeq: number, delayMs: number): Promise<void> {
  await drawQueue.add(
    'draw',
    { gameId, expectedSeq },
    { delay: Math.max(delayMs, 0), jobId: `draw:${gameId}:${expectedSeq}` },
  );
}

/** Cancels a pending timeout job, used when the tick advances early. */
export async function cancelScheduledDraw(gameId: string, expectedSeq: number): Promise<void> {
  const job = await drawQueue.getJob(`draw:${gameId}:${expectedSeq}`);
  if (job) {
    const state = await job.getState();
    if (state === 'delayed' || state === 'waiting') await job.remove();
  }
}

export const MAINTENANCE_QUEUE = 'maintenance';

export const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, {
  connection: createQueueConnection(),
  defaultJobOptions: { removeOnComplete: 50, removeOnFail: 50, attempts: 2 },
});

/**
 * Arms the recurring housekeeping job: abandoned-game sweep, metric rollups and
 * message-body archiving. The fixed repeat key means restarting the process
 * re-uses the same schedule rather than stacking duplicates.
 */
export async function scheduleMaintenance(): Promise<void> {
  await maintenanceQueue.add(
    'maintenance',
    {},
    {
      repeat: { every: env.MAINTENANCE_INTERVAL_MINUTES * 60_000 },
      jobId: 'maintenance:recurring',
    },
  );
}

/**
 * Arms the operator digest.
 *
 * Shares the maintenance queue rather than adding a third: both are periodic
 * housekeeping, and one more queue would mean one more worker, one more
 * connection and one more thing to notice has stopped.
 *
 * The fixed repeat key means restarting re-uses the schedule instead of
 * stacking a second timer — which would double every alert.
 */
export async function scheduleDigest(): Promise<void> {
  await maintenanceQueue.add(
    'digest',
    {},
    {
      repeat: { every: env.ALERT_DIGEST_MINUTES * 60_000 },
      jobId: 'digest:recurring',
    },
  );
}
