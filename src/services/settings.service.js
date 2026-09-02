/**
 * Settings an operator can change from the panel, without a redeploy.
 *
 * Each one falls back to its .env variable when nothing is stored, so a fresh
 * database behaves exactly as the environment describes and there is only ever
 * one answer to "what is this set to".
 *
 * The effective values are cached in memory because they are read on paths
 * that cannot be async - the WhatsApp copy builder, for one - and they change
 * about once a month. Every write refreshes the cache immediately, so the
 * panel never shows a value it just replaced.
 */
import { query } from '../db/pool.js';
import { config } from '../config/env.js';
import { log } from '../utils/logger.js';

export const KEYS = { TRIAL_ENDS_AT: 'free_trial_ends_at' };

const cache = new Map();

/** Reads every stored setting into the cache. Called once at boot. */
export async function loadSettings() {
  try {
    const { rows } = await query('SELECT key, value, updated_at, updated_by FROM app_settings');
    cache.clear();
    for (const r of rows) cache.set(r.key, r);
    log.info('settings loaded', { stored: rows.length });
  } catch (err) {
    // A missing table must not stop the server booting - the env defaults are
    // a complete configuration on their own.
    log.warn('could not load app_settings, using .env defaults', { message: err.message });
  }
}

export async function setSetting(key, value, updatedBy = 'admin') {
  if (value === null || value === undefined) {
    await query('DELETE FROM app_settings WHERE key = $1', [key]);
    cache.delete(key);
    log.info('setting reset to the .env default', { key, by: updatedBy });
    return;
  }
  const { rows } = await query(
    `INSERT INTO app_settings (key, value, updated_by)
          VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
      RETURNING key, value, updated_at, updated_by`,
    [key, String(value), updatedBy],
  );
  cache.set(key, rows[0]);
  log.info('setting saved', { key, value, by: updatedBy });
}

/** The value in force right now: stored if present, otherwise the .env one. */
export function effective(key, envFallback) {
  return cache.get(key)?.value ?? envFallback;
}

export function meta(key) {
  const row = cache.get(key);
  return {
    source: row ? 'database' : 'environment',
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  };
}

// --- Free trial ------------------------------------------------------------

export function trialEndsAt() {
  return effective(KEYS.TRIAL_ENDS_AT, config.freeTrialEndsAt);
}

/**
 * @param {string|null} endsAt ISO timestamp, or null to fall back to .env
 */
export async function setTrialEndsAt(endsAt, updatedBy) {
  if (endsAt !== null) {
    const when = new Date(endsAt);
    if (Number.isNaN(when.getTime())) {
      throw new Error(`"${endsAt}" is not a date we can read`);
    }
    endsAt = when.toISOString();
  }
  await setSetting(KEYS.TRIAL_ENDS_AT, endsAt, updatedBy);
  return trialState();
}

/** Everything the trial screen and the WhatsApp plan card need. */
export function trialState() {
  const endsAt = trialEndsAt();
  const daysLeft = Math.ceil((new Date(endsAt).getTime() - Date.now()) / 86_400_000);
  return {
    freeTrialEndsAt: endsAt,
    environmentDefault: config.freeTrialEndsAt,
    daysRemaining: daysLeft,
    isOver: daysLeft <= 0,
    monetizationEnabled: false,
    ...meta(KEYS.TRIAL_ENDS_AT),
  };
}
