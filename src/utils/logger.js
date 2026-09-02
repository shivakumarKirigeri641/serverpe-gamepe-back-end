/**
 * Small levelled logger. Deliberately dependency-free - one file beats a
 * logging framework for an app this size.
 */
import { config } from '../config/env.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, msg, meta) {
  if (LEVELS[level] > threshold) return;
  const time = new Date().toISOString().slice(11, 23);
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
