/**
 * Operator alerts by email.
 *
 * Every trigger is one of three modes, set per trigger from the admin panel:
 *
 *   instant - emailed the moment it happens
 *   digest  - collected and sent as one email every ALERT_DIGEST_MINUTES
 *   off     - still recorded in analytics_events, just never emailed
 *
 * The digest exists because the honest default for something like "someone
 * tapped the WhatsApp button" is NOT instant. At a hundred players a day that
 * is a hundred separate emails, and an inbox that noisy gets filtered - which
 * means the one alert that mattered gets filtered too. High-frequency triggers
 * default to digest, rare and urgent ones to instant.
 *
 * Nothing here can break a game: every function swallows its own errors.
 */
import { query } from '../db/pool.js';
import { config } from '../config/env.js';
import { log } from '../utils/logger.js';
import { sendMail, mailConfigured } from './mailer.service.js';

/**
 * Every alert, with the default that suits how often it actually fires.
 *
 * `label` and `description` are what the admin panel shows.
 */
export const TRIGGERS = [
  {
    key: 'player.tapped',
    label: 'Someone tapped the WhatsApp button',
    description: 'A person messaged the bot — their first ever message, or a return after a while.',
    subject: 'Someone tapped WhatsApp',
    // The highest-volume event by far. Instant would be unusable.
    mode: 'digest',
  },
  {
    key: 'game.created',
    label: 'Host initialised a game room',
    description: 'A host chose a player count and created a room. They may not have started it yet.',
    subject: 'Host initialised the game room',
    mode: 'digest',
  },
  {
    key: 'game.started',
    label: 'Game started',
    description: 'A host tapped Start and the numbers began.',
    subject: 'Game started',
    mode: 'digest',
  },
  {
    key: 'game.ended',
    label: 'Game ended',
    description: 'A game finished — Full House, all 90 numbers called, or abandoned.',
    subject: 'Game ended',
    mode: 'digest',
  },
  {
    key: 'feedback.given',
    label: 'Feedback given',
    description: 'A player rated a game or left a comment.',
    subject: 'Feedback given',
    mode: 'digest',
  },
  {
    key: 'support.raised',
    label: 'Support ticket raised',
    description: 'A player opened a support request. Someone is waiting for an answer.',
    // Rare, and a person is waiting. This is the one that should interrupt you.
    subject: 'Support ticket raised',
    mode: 'instant',
  },

  // --- the ones worth having that were not asked for ---------------------
  {
    key: 'support.replied',
    label: 'Player replied to a ticket',
    description: 'A player added to an open ticket on WhatsApp. Easy to miss without this.',
    subject: 'Player replied to a support ticket',
    mode: 'instant',
  },
  {
    key: 'game.abandoned',
    label: 'Game abandoned',
    description: 'A game stopped because too few players were left. Real people had a bad experience.',
    subject: 'A game was abandoned',
    mode: 'instant',
  },
  {
    key: 'whatsapp.failing',
    label: 'WhatsApp sending is failing',
    description: 'Outbound messages are being rejected — usually an expired token. The bot is effectively down.',
    subject: 'WhatsApp sending is FAILING',
    mode: 'instant',
  },
  {
    key: 'draws.stalled',
    label: 'A game has stalled',
    description: 'A running game has not drawn a number when it should have. Players are staring at a frozen board.',
    subject: 'A game has stalled',
    mode: 'instant',
  },
  {
    key: 'daily.summary',
    label: 'Daily summary',
    description: 'Yesterday in one email: players, games, prizes, failures and open tickets.',
    subject: 'Daily summary',
    mode: 'digest',
  },
];

const byKey = new Map(TRIGGERS.map((t) => [t.key, t]));

/** Seeds any trigger that does not have a row yet. Safe to run at every boot. */
export async function ensureTriggers() {
  for (const t of TRIGGERS) {
    await query(
      `INSERT INTO notification_settings (trigger_key, mode)
            VALUES ($1, $2) ON CONFLICT (trigger_key) DO NOTHING`,
      [t.key, t.mode],
    );
  }
  // A trigger removed from the code should not linger in the panel.
  await query(
    `DELETE FROM notification_settings WHERE trigger_key <> ALL($1)`,
    [TRIGGERS.map((t) => t.key)],
  );
}

export async function listSettings() {
  const { rows } = await query('SELECT * FROM notification_settings');
  const stored = new Map(rows.map((r) => [r.trigger_key, r]));
  return TRIGGERS.map((t) => ({
    trigger_key: t.key,
    label: t.label,
    description: t.description,
    mode: stored.get(t.key)?.mode ?? t.mode,
    recipient: stored.get(t.key)?.recipient ?? null,
    updated_at: stored.get(t.key)?.updated_at ?? null,
  }));
}

export async function setMode(key, mode, by) {
  if (!byKey.has(key)) throw new Error(`"${key}" is not a known alert`);
  if (!['instant', 'digest', 'off'].includes(mode)) throw new Error(`"${mode}" is not a valid mode`);

  await query(
    `INSERT INTO notification_settings (trigger_key, mode, updated_by, updated_at)
          VALUES ($1, $2, $3, now())
     ON CONFLICT (trigger_key) DO UPDATE
            SET mode = EXCLUDED.mode, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, mode, by ?? 'admin'],
  );
  log.info('alert mode changed', { key, mode, by });
  return listSettings();
}

async function modeFor(key) {
  const { rows } = await query('SELECT mode FROM notification_settings WHERE trigger_key = $1', [key]);
  return rows[0]?.mode ?? byKey.get(key)?.mode ?? 'off';
}

/** The subject line, on one line — email subjects cannot contain a newline. */
function subjectFor(key) {
  return `${config.business.legalName} — ${byKey.get(key)?.subject ?? key}`;
}

/**
 * Records something worth telling the operator about.
 *
 * Fire-and-forget from the caller's point of view: an alert that fails must
 * never affect the game that triggered it.
 */
export async function notify(key, { title, lines = [], playerId = null, gameId = null } = {}) {
  try {
    if (!config.alerts.enabled) return;
    const mode = await modeFor(key);
    if (mode === 'off') return;

    const body = [
      config.business.legalName,
      '',
      title || byKey.get(key)?.subject || key,
      '',
      ...lines,
      '',
      `— ${config.brandName} · ${new Date().toLocaleString('en-IN', { timeZone: config.timezone })}`,
    ].join('\n');

    const { rows } = await query(
      `INSERT INTO notification_queue (trigger_key, subject, body, player_id, game_id)
            VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [key, subjectFor(key), body, playerId, gameId],
    );

    if (mode === 'instant') await sendOne(rows[0].id, key, subjectFor(key), body);
  } catch (err) {
    log.warn('could not queue alert', { key, message: err.message });
  }
}

async function sendOne(id, key, subject, body) {
  const result = await sendMail({ to: config.alerts.recipient, subject, text: body });
  await query('UPDATE notification_queue SET sent_at = now() WHERE id = $1', [id]);
  await query(
    `INSERT INTO notification_log (kind, subject, recipient, event_count, ok, error)
          VALUES ('instant', $1, $2, 1, $3, $4)`,
    [subject, config.alerts.recipient, result.sent, result.error ?? null],
  );
}

/**
 * Sends everything waiting as one email.
 *
 * Grouped by trigger so the digest reads as a summary rather than a log:
 * "3 games started" with the detail underneath, not three separate blocks.
 */
export async function sendDigest({ force = false } = {}) {
  if (!config.alerts.enabled && !force) return { sent: false, reason: 'alerts are disabled' };

  const { rows } = await query(
    `SELECT id, trigger_key, body FROM notification_queue
      WHERE sent_at IS NULL ORDER BY created_at LIMIT 500`,
  );
  if (rows.length === 0) return { sent: false, reason: 'nothing waiting' };

  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.trigger_key)) groups.set(r.trigger_key, []);
    groups.get(r.trigger_key).push(r.body);
  }

  const parts = [config.business.legalName, '', `Activity in the last ${config.alerts.digestMinutes} minutes`, ''];
  for (const [key, bodies] of groups) {
    const t = byKey.get(key);
    parts.push(`### ${t?.label ?? key} — ${bodies.length}`);
    // Only the middle of each queued body; the brand header and footer would
    // repeat pointlessly inside a digest.
    for (const b of bodies.slice(0, 20)) {
      parts.push(...b.split('\n').slice(2, -2).filter(Boolean).map((l) => '  ' + l), '');
    }
    if (bodies.length > 20) parts.push(`  …and ${bodies.length - 20} more`, '');
  }
  parts.push(`— ${config.brandName} · ${new Date().toLocaleString('en-IN', { timeZone: config.timezone })}`);

  const subject = `${config.business.legalName} — ${rows.length} update${rows.length === 1 ? '' : 's'}`;
  const result = await sendMail({ to: config.alerts.recipient, subject, text: parts.join('\n') });

  await query(
    'UPDATE notification_queue SET sent_at = now() WHERE id = ANY($1)',
    [rows.map((r) => r.id)],
  );
  await query(
    `INSERT INTO notification_log (kind, subject, recipient, event_count, ok, error)
          VALUES ('digest', $1, $2, $3, $4, $5)`,
    [subject, config.alerts.recipient, rows.length, result.sent, result.error ?? null],
  );

  log.info('digest sent', { events: rows.length, ok: result.sent });
  return { sent: result.sent, events: rows.length, error: result.error ?? null };
}

/** What the next digest would contain, without sending it. */
export async function digestPreview() {
  const mins = config.alerts.digestMinutes;
  const { rows } = await query(`
    SELECT
      (SELECT count(*)::int FROM notification_queue WHERE sent_at IS NULL)            AS pending,
      (SELECT count(*)::int FROM players
        WHERE created_at > now() - make_interval(mins => $1))                         AS new_players,
      (SELECT count(DISTINCT player_id)::int FROM analytics_events
        WHERE occurred_at > now() - make_interval(mins => $1))                        AS active,
      (SELECT count(*)::int FROM games
        WHERE created_at > now() - make_interval(mins => $1))                         AS games_created,
      (SELECT count(*)::int FROM games
        WHERE started_at > now() - make_interval(mins => $1))                         AS games_started,
      (SELECT count(*)::int FROM games
        WHERE status='finished' AND ended_at > now() - make_interval(mins => $1))     AS games_completed,
      (SELECT count(*)::int FROM games
        WHERE status='abandoned' AND ended_at > now() - make_interval(mins => $1))    AS games_abandoned,
      (SELECT count(*)::int FROM claims
        WHERE status='awarded' AND created_at > now() - make_interval(mins => $1))    AS prizes,
      (SELECT count(*)::int FROM messages
        WHERE direction='in' AND created_at > now() - make_interval(mins => $1))      AS inbound,
      (SELECT count(*)::int FROM messages
        WHERE direction='out' AND created_at > now() - make_interval(mins => $1))     AS outbound,
      (SELECT count(*)::int FROM messages
        WHERE direction='out' AND status='failed'
          AND created_at > now() - make_interval(mins => $1))                         AS failed,
      (SELECT count(*)::int FROM feedback
        WHERE created_at > now() - make_interval(mins => $1))                         AS feedback,
      (SELECT count(*)::int FROM support_tickets
        WHERE status IN ('open','in_progress'))                                        AS tickets,
      (SELECT count(*)::int FROM blocked_numbers)                                      AS blocked
  `, [mins]);
  const r = rows[0];

  return {
    windowMinutes: mins,
    pending: r.pending,
    players: { new: r.new_players, active: r.active },
    games: {
      created: r.games_created, started: r.games_started,
      completed: r.games_completed, abandoned: r.games_abandoned,
    },
    messages: { inbound: r.inbound, outbound: r.outbound, failed: r.failed },
    feedback: { count: r.feedback },
    trial: { signups: r.new_players, played: r.games_started, returning: 0, endsAt: null },
    prizes: r.prizes,
    tickets: r.tickets,
    blocked: r.blocked,
  };
}

export async function recentLog(limit = 20) {
  const { rows } = await query(
    `SELECT kind, subject, recipient, event_count, ok, error, sent_at
       FROM notification_log ORDER BY sent_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

export function status() {
  return {
    enabled: config.alerts.enabled,
    configured: mailConfigured(),
    digestMinutes: config.alerts.digestMinutes,
    from: config.mail.user || '(unset)',
    to: config.alerts.recipient,
  };
}
