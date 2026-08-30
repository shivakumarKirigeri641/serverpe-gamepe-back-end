import { query, queryOne } from '../db/pool.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { appDate, appTimeString } from '../utils/time.js';
import { sendMail, mailConfigured, type Attachment } from './mailer.service.js';
import { buildDigestPdf } from './digest-report.service.js';

/**
 * Operator alerts.
 *
 * Events are queued and sent as one digest every ALERT_DIGEST_MINUTES, not on
 * the spot. Thirty players joining a room would be thirty emails, and an inbox
 * that floods is an inbox that gets muted — at which point the alerts have
 * negative value, because now you believe you are being told.
 *
 * One trigger is instant by default: a support ticket, where somebody is
 * actually waiting. Which triggers are instant, batched or off is a row in
 * notification_settings, editable from the admin panel, because that decision
 * changes far more often than configuration does.
 */

export type TriggerKey =
  | 'player.first_contact'
  | 'game.started'
  | 'game.ended'
  | 'feedback.received'
  | 'support.ticket'
  | 'player.blocked'
  | 'payment.received';

interface Setting {
  trigger_key: string;
  label: string;
  enabled: boolean;
  mode: 'digest' | 'instant' | 'off';
  recipient: string | null;
}

const settingsCache = new Map<string, { value: Setting | null; at: number }>();
const CACHE_MS = 60_000;

async function settingFor(key: string): Promise<Setting | null> {
  const hit = settingsCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const value = await queryOne<Setting>(
    `SELECT trigger_key, label, enabled, mode, recipient
       FROM notification_settings WHERE trigger_key = $1`,
    [key],
  );
  settingsCache.set(key, { value, at: Date.now() });
  return value;
}

export function clearSettingsCache(): void {
  settingsCache.clear();
}

export interface NotifyInput {
  trigger: TriggerKey;
  summary: string;
  detail?: Record<string, unknown>;
  playerId?: string | null;
  gameId?: string | null;
  waId?: string | null;
}

/**
 * Records something worth telling the operator about.
 *
 * Fire-and-forget by design and never throws: an alert failing must not break
 * the game that produced it. Callers use `void notify(...)` deliberately.
 */
export async function notify(input: NotifyInput): Promise<void> {
  try {
    if (!env.ADMIN_NOTIFICATIONS_ENABLED) return;

    const setting = await settingFor(input.trigger);
    if (!setting || !setting.enabled || setting.mode === 'off') return;

    const row = await queryOne<{ id: string }>(
      `INSERT INTO notification_queue (trigger_key, summary, detail, player_id, game_id, wa_id)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6)
       RETURNING id`,
      [
        input.trigger,
        input.summary.slice(0, 500),
        JSON.stringify(input.detail ?? {}),
        input.playerId ?? null,
        input.gameId ?? null,
        input.waId ?? null,
      ],
    );

    if (setting.mode === 'instant' && row) {
      await sendInstant(row.id, setting, input);
    }
  } catch (err) {
    logger.warn({ err, trigger: input.trigger }, 'could not queue notification');
  }
}

async function sendInstant(id: string, setting: Setting, input: NotifyInput): Promise<void> {
  const subject = `[${env.BRAND_NAME}] ${setting.label}`;
  const body = [input.summary, '', JSON.stringify(input.detail ?? {}, null, 2)].join('\n');

  const result = await sendMail({
    to: setting.recipient ?? undefined,
    subject,
    text: body,
    html: `<p>${escapeHtml(input.summary)}</p><pre>${escapeHtml(
      JSON.stringify(input.detail ?? {}, null, 2),
    )}</pre>`,
  });

  await query(
    `INSERT INTO notification_log (kind, recipient, subject, event_count, ok, error)
     VALUES ('instant', $1, $2, 1, $3, $4)`,
    [result.recipient, subject, result.ok, result.error ?? null],
  );

  if (result.ok) {
    await query(`UPDATE notification_queue SET sent_at = now() WHERE id = $1`, [id]);
  }
}

/* ------------------------------------------------------------------ digest */

export interface DigestStats {
  windowMinutes: number;
  players: { total: number; new: number; active: number };
  games: { created: number; started: number; completed: number; cancelled: number; abandoned: number };
  messages: { inbound: number; outbound: number; failed: number };
  prizes: number;
  feedback: { count: number; avgRating: number | null };
  tickets: number;
  blocked: number;
  trial: { endsOn: string; daysRemaining: number; signups: number; played: number; returning: number };
}

/** Everything the digest reports, gathered in one pass. */
export async function gatherDigestStats(windowMinutes: number): Promise<DigestStats> {
  const since = `${windowMinutes} minutes`;

  const row = await queryOne<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM players)                                                   AS players_total,
       (SELECT count(*) FROM players WHERE created_at > now() - $1::interval)           AS players_new,
       (SELECT count(*) FROM players WHERE last_seen_at > now() - $1::interval)          AS players_active,
       (SELECT count(*) FROM games WHERE created_at > now() - $1::interval)             AS games_created,
       (SELECT count(*) FROM games WHERE started_at > now() - $1::interval)             AS games_started,
       (SELECT count(*) FROM games WHERE ended_at > now() - $1::interval
          AND status = 'completed')                                                      AS games_completed,
       (SELECT count(*) FROM games WHERE ended_at > now() - $1::interval
          AND status = 'cancelled')                                                      AS games_cancelled,
       (SELECT count(*) FROM message_log WHERE created_at > now() - $1::interval
          AND direction = 'inbound')                                                     AS msg_in,
       (SELECT count(*) FROM message_log WHERE created_at > now() - $1::interval
          AND direction = 'outbound')                                                    AS msg_out,
       (SELECT count(*) FROM message_log WHERE created_at > now() - $1::interval
          AND status = 'failed')                                                         AS msg_failed,
       (SELECT count(*) FROM game_claims WHERE created_at > now() - $1::interval
          AND status = 'awarded')                                                        AS prizes,
       (SELECT count(*) FROM game_feedback WHERE created_at > now() - $1::interval)      AS feedback_count,
       (SELECT round(avg(rating), 2) FROM game_feedback
          WHERE created_at > now() - $1::interval)                                       AS feedback_avg,
       (SELECT count(*) FROM support_tickets WHERE created_at > now() - $1::interval)    AS tickets,
       (SELECT count(*) FROM blocked_numbers WHERE blocked_at > now() - $1::interval)    AS blocked,
       (SELECT count(DISTINCT player_id) FROM game_players)                              AS trial_played,
       (SELECT count(*) FROM (
          SELECT gp.player_id FROM game_players gp JOIN games g ON g.id = gp.game_id
           GROUP BY gp.player_id
          HAVING count(DISTINCT (g.created_at AT TIME ZONE $2)::date) > 1) r)            AS trial_returning`,
    [since, env.APP_TIMEZONE],
  );

  const n = (k: string): number => Number(row?.[k] ?? 0);
  const end = new Date(env.FREE_TRIAL_ENDS_AT);

  return {
    windowMinutes,
    players: { total: n('players_total'), new: n('players_new'), active: n('players_active') },
    games: {
      created: n('games_created'),
      started: n('games_started'),
      completed: n('games_completed'),
      cancelled: n('games_cancelled'),
      abandoned: Math.max(n('games_created') - n('games_started'), 0),
    },
    messages: { inbound: n('msg_in'), outbound: n('msg_out'), failed: n('msg_failed') },
    prizes: n('prizes'),
    feedback: {
      count: n('feedback_count'),
      avgRating: row?.['feedback_avg'] ? Number(row['feedback_avg']) : null,
    },
    tickets: n('tickets'),
    blocked: n('blocked'),
    trial: {
      endsOn: appDate(end),
      daysRemaining: Math.max(Math.ceil((end.getTime() - Date.now()) / 86_400_000), 0),
      signups: n('players_total'),
      played: n('trial_played'),
      returning: n('trial_returning'),
    },
  };
}

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statRow(label: string, value: string | number, note = ''): string {
  return `<tr>
    <td style="padding:6px 10px;color:#6b7684;border-bottom:1px solid #eef1f5">${escapeHtml(label)}</td>
    <td style="padding:6px 10px;font-weight:700;text-align:right;border-bottom:1px solid #eef1f5">${escapeHtml(String(value))}</td>
    <td style="padding:6px 10px;color:#9aa4b0;font-size:12px;border-bottom:1px solid #eef1f5">${escapeHtml(note)}</td>
  </tr>`;
}

function renderHtml(stats: DigestStats, events: Array<{ trigger_key: string; summary: string; created_at: Date }>): string {
  const grouped = new Map<string, string[]>();
  for (const e of events) {
    const list = grouped.get(e.trigger_key) ?? [];
    list.push(e.summary);
    grouped.set(e.trigger_key, list);
  }

  const eventHtml = [...grouped.entries()]
    .map(
      ([key, items]) => `<h3 style="margin:18px 0 6px;font-size:14px;color:#7d0f22">${escapeHtml(key)} (${items.length})</h3>
        <ul style="margin:0;padding-left:18px;color:#1e2733;font-size:13px;line-height:1.6">
          ${items.slice(0, 40).map((s) => `<li>${escapeHtml(s)}</li>`).join('')}
          ${items.length > 40 ? `<li style="color:#6b7684">and ${items.length - 40} more</li>` : ''}
        </ul>`,
    )
    .join('');

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#1e2733">
    <div style="background:linear-gradient(135deg,#7d0f22,#5c0a19);color:#fff;padding:20px 22px;border-radius:12px 12px 0 0">
      <div style="font-size:20px;font-weight:800">${escapeHtml(env.BRAND_NAME)}</div>
      <div style="opacity:.85;font-size:13px;margin-top:3px">Last ${stats.windowMinutes} minutes · ${escapeHtml(appTimeString())}</div>
    </div>

    <div style="border:1px solid #e2e7ee;border-top:0;border-radius:0 0 12px 12px;padding:16px 12px">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        ${statRow('New people', stats.players.new, `${stats.players.total} total`)}
        ${statRow('Active in this window', stats.players.active)}
        ${statRow('Games created', stats.games.created)}
        ${statRow('Games started', stats.games.started)}
        ${statRow('Games completed', stats.games.completed)}
        ${statRow('Games cancelled', stats.games.cancelled)}
        ${statRow('Rooms never started', stats.games.abandoned, 'created but no first number')}
        ${statRow('Prizes won', stats.prizes)}
        ${statRow('Messages in / out', `${stats.messages.inbound} / ${stats.messages.outbound}`)}
        ${statRow('Failed sends', stats.messages.failed, stats.messages.failed > 0 ? 'needs a look' : '')}
        ${statRow('Feedback', stats.feedback.count, stats.feedback.avgRating ? `avg ${stats.feedback.avgRating}/5` : '')}
        ${statRow('Support tickets', stats.tickets)}
        ${statRow('Numbers blocked', stats.blocked)}
      </table>

      <h3 style="margin:20px 0 6px;font-size:14px;color:#7d0f22">Free trial</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        ${statRow('Signups so far', stats.trial.signups)}
        ${statRow('Have played', stats.trial.played)}
        ${statRow('Came back (2+ days)', stats.trial.returning, 'the number that predicts renewals')}
        ${statRow('Trial ends', stats.trial.endsOn, `${stats.trial.daysRemaining} days left`)}
      </table>

      ${eventHtml || '<p style="color:#6b7684;font-size:13px;margin-top:18px">No individual events in this window.</p>'}

      <p style="color:#9aa4b0;font-size:11px;margin-top:22px;border-top:1px solid #eef1f5;padding-top:10px">
        Sent by ${escapeHtml(env.BRAND_NAME)} to ${escapeHtml(env.ALERT_RECIPIENT)}.
        Turn individual alerts off in the admin panel under Notifications.
        Full report attached as a PDF.
      </p>
    </div>
  </div>`;
}

function renderText(stats: DigestStats): string {
  return [
    `${env.BRAND_NAME} — last ${stats.windowMinutes} minutes (${appTimeString()})`,
    '',
    `New people:        ${stats.players.new} (${stats.players.total} total)`,
    `Active:            ${stats.players.active}`,
    `Games created:     ${stats.games.created}`,
    `Games started:     ${stats.games.started}`,
    `Games completed:   ${stats.games.completed}`,
    `Games cancelled:   ${stats.games.cancelled}`,
    `Prizes won:        ${stats.prizes}`,
    `Messages in/out:   ${stats.messages.inbound} / ${stats.messages.outbound}`,
    `Failed sends:      ${stats.messages.failed}`,
    `Feedback:          ${stats.feedback.count}${stats.feedback.avgRating ? ` (avg ${stats.feedback.avgRating}/5)` : ''}`,
    `Support tickets:   ${stats.tickets}`,
    `Blocked:           ${stats.blocked}`,
    '',
    `Trial: ${stats.trial.signups} signups, ${stats.trial.played} played, ${stats.trial.returning} returning.`,
    `Ends ${stats.trial.endsOn} (${stats.trial.daysRemaining} days left).`,
  ].join('\n');
}

export interface DigestResult {
  sent: boolean;
  reason?: string;
  events: number;
  recipient?: string;
}

/**
 * Builds and sends the periodic digest.
 *
 * Sends nothing when there is nothing to say. A digest that arrives every ten
 * minutes saying "0, 0, 0" is the fastest way to train someone to ignore the
 * subject line, and then the one that matters is ignored too.
 */
export async function sendDigest(force = false): Promise<DigestResult> {
  if (!env.ADMIN_NOTIFICATIONS_ENABLED && !force) {
    return { sent: false, reason: 'notifications disabled', events: 0 };
  }
  if (!mailConfigured()) {
    return { sent: false, reason: 'mail is not configured', events: 0 };
  }

  const pending = await query<{ id: string; trigger_key: string; summary: string; created_at: Date }>(
    `SELECT q.id, q.trigger_key, q.summary, q.created_at
       FROM notification_queue q
       JOIN notification_settings s ON s.trigger_key = q.trigger_key
      WHERE q.sent_at IS NULL AND s.enabled AND s.mode = 'digest'
      ORDER BY q.created_at
      LIMIT 500`,
  );

  if (pending.length === 0 && !force) {
    return { sent: false, reason: 'nothing to report', events: 0 };
  }

  const stats = await gatherDigestStats(env.ALERT_DIGEST_MINUTES);

  let attachments: Attachment[] | undefined;
  try {
    const pdf = await buildDigestPdf(stats, pending);
    attachments = [{ filename: pdf.filename, content: pdf.buffer, contentType: 'application/pdf' }];
  } catch (err) {
    // The numbers are in the body too; losing the attachment must not lose the
    // email.
    logger.warn({ err }, 'could not build digest PDF, sending without it');
  }

  const subject =
    `[${env.BRAND_NAME}] ${stats.players.new} new · ${stats.games.started} games · ` +
    `${stats.trial.signups} signups`;

  const result = await sendMail({
    subject,
    html: renderHtml(stats, pending),
    text: renderText(stats),
    attachments,
  });

  await query(
    `INSERT INTO notification_log (kind, recipient, subject, event_count, ok, error)
     VALUES ('digest', $1, $2, $3, $4, $5)`,
    [result.recipient, subject, pending.length, result.ok, result.error ?? null],
  );

  if (result.ok && pending.length > 0) {
    await query(`UPDATE notification_queue SET sent_at = now() WHERE id = ANY($1::uuid[])`, [
      pending.map((p) => p.id),
    ]);
  }

  return {
    sent: result.ok,
    reason: result.error,
    events: pending.length,
    recipient: result.recipient,
  };
}

/* ------------------------------------------------------------------- admin */

export async function listSettings(): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT trigger_key, label, description, enabled, mode, recipient, display_order, updated_at
       FROM notification_settings ORDER BY display_order`,
  );
}

export async function updateSetting(
  triggerKey: string,
  patch: { enabled?: boolean; mode?: string; recipient?: string | null },
): Promise<void> {
  await query(
    `UPDATE notification_settings
        SET enabled   = COALESCE($2, enabled),
            mode      = COALESCE($3, mode),
            recipient = $4,
            updated_at = now()
      WHERE trigger_key = $1`,
    [triggerKey, patch.enabled ?? null, patch.mode ?? null, patch.recipient ?? null],
  );
  clearSettingsCache();
}

export async function recentLog(limit: number): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT kind, recipient, subject, event_count, ok, error, sent_at
       FROM notification_log ORDER BY sent_at DESC LIMIT $1`,
    [limit],
  );
}

export async function pendingCount(): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM notification_queue WHERE sent_at IS NULL`,
  );
  return Number(row?.n ?? 0);
}
