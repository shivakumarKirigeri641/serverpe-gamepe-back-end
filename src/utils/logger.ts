import pino from 'pino';
import { env } from '../config/env.js';

/**
 * Pretty by default in development, JSON by default in production — and
 * LOG_PRETTY overrides either way.
 *
 * The override exists because the two audiences are different people at
 * different moments. JSON is right for a log shipper and for grepping a month
 * later; it is the wrong thing to hand somebody watching their own launch, who
 * needs to see at a glance that a message arrived and a reply went out.
 */
const pretty =
  env.LOG_PRETTY === undefined
    ? env.NODE_ENV === 'development'
    : ['1', 'true', 'yes', 'on'].includes(env.LOG_PRETTY.toLowerCase());

export const logger = pino({
  level: env.LOG_LEVEL,
  transport: pretty
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          // The message carries the story; the object behind it is detail for
          // when something looks wrong. Keeping the common keys out of the tail
          // is what makes a screen of these readable.
          ignore: 'pid,hostname,evt,playerId,gameId,roomCode',
        },
      }
    : undefined,
});

export type Logger = typeof logger;
