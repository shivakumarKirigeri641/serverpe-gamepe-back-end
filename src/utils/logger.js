/**
 * Small levelled logger. Deliberately dependency-free - one file beats a
 * logging framework for an app this size.
 */
import { config } from '../config/env.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

/**
 * The clock the logs are read on.
 *
 * toISOString() is UTC, so every line was stamped five and a half hours behind
 * the people reading it: an operator matching a log line against "the game that
 * broke at half past three" was looking in the wrong place entirely. The
 * database already stores timestamps with their zone and APP_TIMEZONE already
 * says which one this business runs in - the logs were simply not asking.
 *
 * Built once rather than per line: constructing a DateTimeFormat is far more
 * expensive than formatting with one, and this runs on every log call.
 */
const clock = (() => {
  const opts = {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    fractionalSecondDigits: 3, hour12: false,
  };
  try {
    return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: config.timezone });
  } catch {
    // An unrecognised APP_TIMEZONE must not take the logger down with it -
    // losing the logs is how you lose the ability to diagnose the typo.
    return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' });
  }
})();

function emit(level, msg, meta) {
  if (LEVELS[level] > threshold) return;
  const time = clock.format(new Date());
  const tail = meta === undefined ? '' : ' ' + safeJson(meta);
  const line = `${time} ${level.toUpperCase().padEnd(5)} ${msg}${tail}`;
  (level === 'error' ? console.error : console.log)(line);
}

function safeJson(meta) {
  try {
    return JSON.stringify(meta);
  } catch {
    return String(meta);
  }
}

export const log = {
  error: (msg, meta) => emit('error', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  info: (msg, meta) => emit('info', msg, meta),
  debug: (msg, meta) => emit('debug', msg, meta),
};
