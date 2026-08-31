import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/** Shared connection for ordinary commands. */
export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

redis.on('error', (err) => logger.error({ err }, 'redis error'));

/** BullMQ insists on its own connection with blocking commands enabled. */
export function createQueueConnection(): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

const RELEASE_IF_MINE = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/**
 * Best-effort mutex so two workers can never draw the same number for a game.
 * Returns null if the lock is already held.
 */
export async function acquireLock(
  key: string,
  ttlMs: number,
  token: string,
): Promise<(() => Promise<void>) | null> {
  const ok = await redis.set(`lock:${key}`, token, 'PX', ttlMs, 'NX');
  if (ok !== 'OK') return null;
  return async () => {
    await redis.eval(RELEASE_IF_MINE, 1, `lock:${key}`, token);
  };
}

/** Marks a WhatsApp message id as seen. Returns false if we already handled it. */
export async function markMessageSeen(messageId: string, ttlSeconds = 86_400): Promise<boolean> {
  const ok = await redis.set(`wa:msg:${messageId}`, '1', 'EX', ttlSeconds, 'NX');
  return ok === 'OK';
}
