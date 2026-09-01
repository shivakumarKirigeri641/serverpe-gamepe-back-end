import { query, queryOne } from '../db/pool.js';
import { env, setTrialEndOverride, trialEnd } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Settings an operator changes, as opposed to settings a deployment fixes.
 *
 * The distinction is who owns the value. A database URL belongs to whoever
 * deploys the service; the date the free trial ends belongs to whoever runs the
 * business, and asking them to edit a file on a server and restart it is how a
 * marketing site ends up advertising a date that has already passed.
 *
 * Rows here override the environment. No row means the environment stands, so
 * a fresh install behaves exactly as it did before this table existed.
 *
 * Values are cached in the process because the trial date is read on nearly
 * every message — a database round trip per greeting would be absurd — and the
 * cache is refreshed whenever a value is written and once at boot.
 */

export const SETTING_KEYS = ['free_trial_ends_at'] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export interface SettingRow {
  key: string;
  value: string;
  updated_at: string;
  updated_by: string | null;
}

/** Reads every stored setting and applies it to the process. */
export async function loadSettings(): Promise<void> {
  try {
    const rows = await query<SettingRow>('SELECT key, value, updated_at, updated_by FROM app_settings');
    apply(rows);
  } catch (err) {
    // A missing table means migrations have not run yet, which the caller
    // handles; the environment defaults are perfectly serviceable until then.
    logger.warn({ err }, 'could not load app settings, using environment defaults');
  }
}

function apply(rows: SettingRow[]): void {
  const trial = rows.find((r) => r.key === 'free_trial_ends_at');
  setTrialEndOverride(trial ? new Date(trial.value) : null);
}

/** Current values, with where each one came from — the panel needs to say. */
export async function getSettings(): Promise<{
  freeTrialEndsAt: string;
  source: 'database' | 'environment';
  updatedAt: string | null;
  updatedBy: string | null;
  environmentDefault: string;
}> {
  const row = await queryOne<SettingRow>(
    "SELECT key, value, updated_at, updated_by FROM app_settings WHERE key = 'free_trial_ends_at'",
  );

  return {
    freeTrialEndsAt: trialEnd().toISOString(),
    source: row ? 'database' : 'environment',
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
    environmentDefault: env.FREE_TRIAL_ENDS_AT,
  };
}

/**
 * Moves the trial's end date.
 *
 * Applied to the running process immediately, not on the next restart: the
 * point of putting this in the panel is that the website, the plan taglines and
 * the charging switch all change together the moment it is saved.
 */
export async function setTrialEndsAt(when: Date, by: string): Promise<void> {
  if (Number.isNaN(when.getTime())) throw new Error('That is not a valid date.');

  await query(
    `INSERT INTO app_settings (key, value, updated_by)
     VALUES ('free_trial_ends_at', $1, $2)
     ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [when.toISOString(), by],
  );

  setTrialEndOverride(when);
  logger.info({ endsAt: when.toISOString(), by }, 'free trial end date changed');
}

/** Returns the trial date to whatever the environment says. */
export async function clearTrialEndsAt(): Promise<void> {
  await query("DELETE FROM app_settings WHERE key = 'free_trial_ends_at'");
  setTrialEndOverride(null);
  logger.info({ endsAt: env.FREE_TRIAL_ENDS_AT }, 'free trial end date reset to the environment');
}
