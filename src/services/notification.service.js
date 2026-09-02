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
import * as T from './mail-template.js';

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
    icon: '🔔',
    subject: 'someone tapped "Start on WhatsApp"',
    // The highest-volume event by far. Instant would be unusable.
    mode: 'digest',
  },
  {
    key: 'game.created',
    label: 'Host initialised a game room',
    description: 'A host chose a player count and created a room. They may not have started it yet.',
    icon: '🎯',
    subject: 'a host initialised a game room',
    mode: 'digest',
  },
  {
    key: 'game.started',
    label: 'Game started',
    description: 'A host tapped Start and the numbers began.',
    icon: '🎲',
    subject: 'a game started',
    mode: 'digest',
  },
  {
    key: 'game.ended',
    label: 'Game ended',
    description: 'A game finished — Full House, all 90 numbers called, or abandoned.',
    icon: '🏁',
    subject: 'a game ended',
    mode: 'digest',
  },
  {
    key: 'feedback.given',
    label: 'Feedback given',
    description: 'A player rated a game or left a comment.',
    icon: '⭐',
    subject: 'feedback was given',
    mode: 'digest',
  },
  {
    key: 'support.raised',
    label: 'Support ticket raised',
    description: 'A player opened a support request. Someone is waiting for an answer.',
    // Rare, and a person is waiting. This is the one that should interrupt you.
    icon: '🎫',
    subject: 'a support ticket was raised',
    mode: 'instant',
  },

  // --- the ones worth having that were not asked for ---------------------
  {
    key: 'support.replied',
    label: 'Player replied to a ticket',
    description: 'A player added to an open ticket on WhatsApp. Easy to miss without this.',
    icon: '💬',
    subject: 'a player replied to a ticket',
    mode: 'instant',
  },
  {
    key: 'game.abandoned',
    label: 'Game abandoned',
    description: 'A game stopped because too few players were left. Real people had a bad experience.',
    icon: '⚠️',
    subject: 'a game was abandoned',
    mode: 'instant',
  },
  {
    key: 'whatsapp.failing',
    label: 'WhatsApp sending is failing',
    description: 'Outbound messages are being rejected — usually an expired token. The bot is effectively down.',
    icon: '🚨',
    subject: 'WhatsApp sending is FAILING',
    mode: 'instant',
  },
  {
    key: 'draws.stalled',
    label: 'A game has stalled',
    description: 'A running game has not drawn a number when it should have. Players are staring at a frozen board.',
    icon: '🚨',
    subject: 'a game has stalled',
    mode: 'instant',
  },
  {
    key: 'daily.summary',
    label: 'Daily summary',
    description: 'Yesterday in one email: players, games, prizes, failures and open tickets.',
    icon: '📊',
    subject: 'daily summary',
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

/**
 * The subject line.
 *
 * The company name is deliberately NOT in here. An inbox already shows the
 * sender in its own bold column — repeating "ServerPe App Solutions" would
 * spend the only part of the line a person actually reads on something they
 * can already see. Icon, product, then what happened:
 *
 *   ServerPe App Solutions   🔔 MastiPe — someone tapped "Start on WhatsApp"
 *   └── sender column ───┘   └── subject ─────────────────────────────────┘
 */
function subjectFor(key) {
  const t = byKey.get(key);
  return `${t?.icon ?? '🔔'} ${config.brandName} — ${t?.subject ?? key}`;
}

/**
 * Where the person was, as far as we honestly know.
 *
 * Appended to any alert that names a player, so an operator reading the email
 * on a phone does not have to open the panel to answer the first question they
 * always ask: who, and from where.
 *
 * The location is derived from the IP the BOARD was opened from, never from a
 * browser permission prompt. Two consequences worth remembering before acting
 * on it:
 *
 *   - A player who has only ever used WhatsApp has none of this. Meta's
 *     servers relay the message, so there is no client address to read.
 *   - On mobile data the address is the carrier's gateway, which can be a
 *     different city — and, in India, occasionally a different state. It is a
 *     hint for support and fraud triage, not evidence.
 *
 * "State" covers union territories too; the provider returns Delhi, Puducherry
 * and Chandigarh in the same field as Karnataka, and so do we.
 */
async function originLines(playerId) {
  if (!playerId) return [];
  try {
    const { rows } = await query(
      `SELECT wa_id, display_name, last_ip, last_city, last_region, last_country,
              last_device_type, last_os, last_browser, last_device_at
         FROM players WHERE id = $1`,
      [playerId],
    );
    const p = rows[0];
    if (!p) return [];

    const out = [];
    const place = [p.last_city, p.last_region, p.last_country].filter(Boolean).join(', ');
    if (place) out.push(`Location: ${place}   (approximate - from IP)`);
    if (p.last_ip) out.push(`IP: ${p.last_ip}`);

    const device = [p.last_device_type, p.last_os, p.last_browser].filter(Boolean).join(' · ');
    if (device) out.push(`Device: ${device}`);

    // No board visit means no address at all - say so, rather than leaving a
    // silent gap that reads like a bug.
    if (!p.last_ip && !place) out.push('Location: unknown (WhatsApp only - never opened a board)');

    return out.length ? ['', ...out] : [];
  } catch (err) {
    log.debug('could not resolve origin', { playerId, message: err.message });
    return [];
  }
}

/**
 * Where a whole table played from.
 *
 * Used for game-level alerts, where one player's city would be arbitrary. Same
 * caveats as originLines: IP-derived, board visits only. Shown as a tally
 * because that is the shape the question takes - "was this one household, or
 * six people across three states?"
 */
async function gameOriginLines(gameId) {
  if (!gameId) return [];
  try {
    const { rows } = await query(
      `SELECT coalesce(city, 'unknown')  AS city,
              coalesce(region, '')       AS region,
              count(DISTINCT player_id)::int AS players
         FROM board_sessions
        WHERE game_id = $1
        GROUP BY 1, 2
        ORDER BY players DESC, city
        LIMIT 6`,
      [gameId],
    );
    if (!rows.length) return [];

    const parts = rows.map((r) => {
      const place = r.region && r.city !== 'unknown' ? `${r.city}, ${r.region}` : r.city;
      return `${place} (${r.players})`;
    });
    return ['', `Played from: ${parts.join(' · ')}   (approximate - from IP)`];
  } catch (err) {
    log.debug('could not resolve game origin', { gameId, message: err.message });
    return [];
  }
}

/* ─────────────────────────────────────────────────────── the styled mail ── */

/**
 * Turns the plain-text body every alert already produces into HTML blocks.
 *
 * The text version stays the source of truth. It is what gets queued, what the
 * digest re-reads, and what an operator sees if their client refuses HTML — so
 * rather than maintain two representations of every alert and let them drift,
 * this reads the shape back out of the text:
 *
 *   "Room: ABC123"          a short label and value  ->  a fact row
 *   "Board froze on 42."    prose                    ->  a quote block
 *   ""                      a blank line             ->  ends the group
 *
 * Deliberately forgiving. An unrecognised line becomes a paragraph rather than
 * being dropped: a slightly plain email is a much smaller failure than one
 * that silently loses the sentence explaining what went wrong.
 */
function blocksFromLines(lines) {
  const out = [];
  let pending = [];

  const flush = () => {
    if (pending.length) { out.push(T.facts(pending)); pending = []; }
  };

  for (const raw of lines) {
    const line = String(raw ?? '');
    if (!line.trim()) { flush(); continue; }

    const m = line.match(/^([A-Za-z][A-Za-z0-9 /'()-]{0,28}):\s+(.+)$/);
    if (m) {
      // "(approximate - from IP)" and friends belong beside the value, greyed,
      // not competing with it.
      const [, label, rest] = m;
      const hint = rest.match(/\s{2,}\((.+)\)\s*$/);
      pending.push({
        label,
        value: hint ? rest.slice(0, hint.index).trim() : rest.trim(),
        hint: hint ? `(${hint[1]})` : undefined,
      });
      continue;
    }

    flush();
    // A quoted player message arrives already wrapped in double quotes.
    const quoted = line.match(/^"([\s\S]*)"$/);
    out.push(quoted ? T.quote(quoted[1]) : line.length > 90 ? T.quote(line) : T.paragraph(line));
  }

  flush();
  return out.join('');
}

/** One alert, as a styled email. */
export function renderAlert(key, title, lines) {
  const t = byKey.get(key);
  return T.shell({
    brand: config.brandName,
    company: config.business.legalName,
    eyebrow: t?.label ?? 'Alert',
    icon: t?.icon ?? '🔔',
    title: title || t?.subject || key,
    subtitle: new Date().toLocaleString('en-IN', { timeZone: config.timezone, dateStyle: 'medium', timeStyle: 'short' }),
    preheader: `${t?.subject ?? key} — ${lines.filter(Boolean)[0] ?? ''}`,
    blocks: blocksFromLines(lines) + T.button('Open the admin panel', config.adminUrl || null),
    footNotes: t?.description ? [t.description] : [],
  });
}

/**
 * The batched email.
 *
 * Grouped by trigger and capped, because the failure mode of a digest is not
 * being too short — it is 300 identical blocks that nobody scrolls through.
 */
export function renderDigest(groups, total) {
  let blocks = T.callout(
    [`${total} thing${total === 1 ? '' : 's'} happened in the last ${config.alerts.digestMinutes} minutes.`],
    { tone: 'info' },
  );

  for (const [key, bodies] of groups) {
    const t = byKey.get(key);
    blocks += T.heading(`${t?.icon ?? '•'}  ${t?.label ?? key} — ${bodies.length}`);

    for (const body of bodies.slice(0, 12)) {
      const lines = body.split('\n');
      const title = lines[0];
      // Drop the title and the trailing "— Brand · timestamp" footer; both are
      // already carried by the digest itself.
      const rest = lines.slice(1, -2);
      blocks += T.paragraph(title);
      blocks += blocksFromLines(rest);
      blocks += T.divider();
    }
    if (bodies.length > 12) {
      blocks += T.paragraph(`…and ${bodies.length - 12} more of these.`, { small: true });
    }
  }

  blocks += T.button('Open the admin panel', config.adminUrl || null);

  return T.shell({
    brand: config.brandName,
    company: config.business.legalName,
    eyebrow: 'Batched update',
    icon: '📬',
    title: `${total} update${total === 1 ? '' : 's'}`,
    subtitle: `The last ${config.alerts.digestMinutes} minutes · ${new Date().toLocaleString('en-IN', { timeZone: config.timezone, dateStyle: 'medium', timeStyle: 'short' })}`,
    blocks,
    footNotes: ['These are the alerts set to batch rather than send instantly. Change that per alert in the admin panel.'],
  });
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

    // A player-level alert gets that player's origin; a game-level one gets
    // the spread across the table. Never both - it would just be noise.
    const origin = playerId ? await originLines(playerId) : await gameOriginLines(gameId);
    const detail = [...lines, ...origin];
    const heading = title || byKey.get(key)?.subject || key;

    const body = [
      heading,
      '',
      ...detail,
      '',
      `— ${config.brandName} · ${new Date().toLocaleString('en-IN', { timeZone: config.timezone })}`,
    ].join('\n');

    const { rows } = await query(
      `INSERT INTO notification_queue (trigger_key, subject, body, player_id, game_id)
            VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [key, subjectFor(key), body, playerId, gameId],
    );

    if (mode === 'instant') {
      await sendOne(rows[0].id, key, subjectFor(key), body, renderAlert(key, heading, detail));
    }
  } catch (err) {
    log.warn('could not queue alert', { key, message: err.message });
  }
}

async function sendOne(id, key, subject, body, html) {
  const result = await sendMail({ to: config.alerts.recipient, subject, text: body, html });
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

  const parts = [`Activity in the last ${config.alerts.digestMinutes} minutes`, ''];
  for (const [key, bodies] of groups) {
    const t = byKey.get(key);
    parts.push(`### ${t?.label ?? key} — ${bodies.length}`);
    // Only the middle of each queued body; the brand header and footer would
    // repeat pointlessly inside a digest.
    for (const b of bodies.slice(0, 20)) {
      parts.push(...b.split('\n').slice(0, -2).filter(Boolean).map((l) => '  ' + l), '');
    }
    if (bodies.length > 20) parts.push(`  …and ${bodies.length - 20} more`, '');
  }
  parts.push(`— ${config.brandName} · ${new Date().toLocaleString('en-IN', { timeZone: config.timezone })}`);

  const subject = `📬 ${config.brandName} — ${rows.length} update${rows.length === 1 ? '' : 's'}`;
  const result = await sendMail({
    to: config.alerts.recipient,
    subject,
    text: parts.join('\n'),
    html: renderDigest(groups, rows.length),
  });

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
