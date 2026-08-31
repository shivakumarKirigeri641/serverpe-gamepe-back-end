import { logger } from './logger.js';

/**
 * The running story of the service, in one line per event.
 *
 * The structured logs elsewhere are written for whoever is debugging a specific
 * failure. This is for the different question an operator actually asks —
 * "what is happening right now?" — and answers it in a form that can be read
 * scrolling past at speed, or grepped for one room, or counted for the day.
 *
 * Every line carries `evt`, a stable dotted key. That is what makes the log
 * useful later: `journalctl -u mastipe | grep 'game.'` is a game history, and
 * `grep 'msg.in'` is the day's traffic, without anybody having to parse JSON.
 *
 * Phone numbers are masked. These logs are read over shoulders, pasted into
 * chats and kept for weeks — the wa_id is never worth that exposure, and the
 * last four digits are enough to follow one person through a session.
 */

export type ActivityEvent =
  | 'msg.in'
  | 'msg.out'
  | 'msg.fail'
  | 'game.created'
  | 'game.started'
  | 'game.draw'
  | 'game.claim'
  | 'game.ended'
  | 'pay.ok'
  | 'report.sent';

/** `9198••••2415` — enough to follow one player, not enough to identify them. */
export function maskWaId(waId: string | null | undefined): string {
  if (!waId) return '?';
  const digits = String(waId).replace(/[^0-9]/g, '');
  if (digits.length < 6) return '••••';
  return `${digits.slice(0, 4)}••••${digits.slice(-4)}`;
}

/** One line of the story. `detail` is appended after the event, human first. */
export function activity(evt: ActivityEvent, detail: string, extra?: Record<string, unknown>): void {
  logger.info({ evt, ...extra }, `${evt.padEnd(12)} ${detail}`);
}

/** Trims a player's message for the log: one line, never long enough to wrap. */
export function preview(text: string | null | undefined, max = 48): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
