import { env } from '../config/env.js';

/**
 * All day and week boundaries are computed in the application timezone
 * (Asia/Kolkata by default), never in UTC.
 *
 * This matters more than it looks. IST is UTC+5:30, so a UTC day boundary
 * falls at 05:30 IST — an evening game played at 23:00 IST would be counted on
 * the previous day, and "games today" would be wrong for the busiest hours.
 * Timestamps are still *stored* as timestamptz (UTC internally, unambiguous);
 * only the bucketing is localised.
 */

/** YYYY-MM-DD for the given instant, in the app timezone. */
export function appDate(at: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, which is exactly what Postgres wants.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: env.APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** Today's date in the app timezone. */
export function appToday(): string {
  return appDate();
}

/** N days before today, in the app timezone. */
export function appDaysAgo(days: number): string {
  return appDate(new Date(Date.now() - days * 86_400_000));
}

/** Monday of the week containing `at`, in the app timezone. */
export function appWeekStart(at: Date = new Date()): string {
  const today = appDate(at);
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];

  // Build the date at UTC noon to sidestep DST and offset edge cases, then walk
  // back to Monday. India has no DST, but this keeps the helper safe if the
  // timezone is ever changed.
  const anchor = new Date(Date.UTC(y, m - 1, d, 12));
  const mondayOffset = (anchor.getUTCDay() + 6) % 7;
  anchor.setUTCDate(anchor.getUTCDate() - mondayOffset);
  return anchor.toISOString().slice(0, 10);
}

/** Human-readable local time, for log lines and admin output. */
export function appTimeString(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: env.APP_TIMEZONE,
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(at);
}
