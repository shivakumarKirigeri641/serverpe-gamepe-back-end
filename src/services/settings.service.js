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

export const KEYS = {
  TRIAL_ENDS_AT: 'free_trial_ends_at',
  MAINTENANCE: 'maintenance',
};

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

// --- Maintenance window ----------------------------------------------------

/**
 * Planned downtime, announced everywhere at once.
 *
 * Two independent switches, because they answer different questions:
 *
 *   enabled  - "there IS a maintenance window", set in advance
 *   force    - "we are down RIGHT NOW", regardless of the clock
 *
 * A window that has not started yet is announced but does not block anything,
 * so players get warned before it bites. `force` exists for the case the
 * window was wrong or something broke unexpectedly.
 */
const MAINTENANCE_DEFAULT = {
  enabled: false,
  force: false,
  from: null,
  to: null,
  message: '',
};

export function maintenance() {
  let stored = MAINTENANCE_DEFAULT;
  const raw = effective(KEYS.MAINTENANCE, null);
  if (raw) {
    try {
      stored = { ...MAINTENANCE_DEFAULT, ...JSON.parse(raw) };
    } catch {
      /* a corrupt value must never take the bot down */
    }
  }

  const now = Date.now();
  const from = stored.from ? new Date(stored.from).getTime() : null;
  const to = stored.to ? new Date(stored.to).getTime() : null;

  // No window at all means "as soon as it is enabled"; an open-ended window
  // means "from then until we say otherwise".
  const started = from === null || now >= from;
  const ended = to !== null && now > to;

  const active = stored.force || (stored.enabled && started && !ended);
  const upcoming = stored.enabled && !stored.force && from !== null && now < from;

  return {
    ...stored,
    active,
    upcoming,
    // Reported so a banner can say "back in 40 minutes" rather than "later".
    endsInMinutes: active && to ? Math.max(0, Math.ceil((to - now) / 60_000)) : null,
    startsInMinutes: upcoming ? Math.max(0, Math.ceil((from - now) / 60_000)) : null,
    ...meta(KEYS.MAINTENANCE),
  };
}

export async function setMaintenance(patch, updatedBy) {
  const current = maintenance();
  const next = {
    enabled: patch.enabled ?? current.enabled,
    force: patch.force ?? current.force,
    from: patch.from === undefined ? current.from : patch.from,
    to: patch.to === undefined ? current.to : patch.to,
    message: patch.message === undefined ? current.message : String(patch.message).slice(0, 600),
  };

  for (const key of ['from', 'to']) {
    if (next[key]) {
      const when = new Date(next[key]);
      if (Number.isNaN(when.getTime())) throw new Error(`"${next[key]}" is not a date we can read`);
      next[key] = when.toISOString();
    }
  }
  if (next.from && next.to && new Date(next.to) <= new Date(next.from)) {
    throw new Error('The window must end after it starts');
  }

  await setSetting(KEYS.MAINTENANCE, JSON.stringify(next), updatedBy);
  return maintenance();
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
