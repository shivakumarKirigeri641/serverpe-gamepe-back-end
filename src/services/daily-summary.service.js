/**
 * The morning email: yesterday, in one screen.
 *
 * Written to be read on a phone before anything else is open. Every number
 * that has a sensible comparison carries its change against the day before,
 * because a count on its own ("14 games") says nothing — it is the direction
 * that tells you whether to do something today.
 *
 * Sent once a day, and only once: a marker row in notification_log means a
 * restart at 8:05am cannot send it twice.
 */
import { query } from '../db/pool.js';
import { config } from '../config/env.js';
import { log } from '../utils/logger.js';
import { sendMail } from './mailer.service.js';

const TZ = 'Asia/Kolkata';

/**
 * Everything for one day, and the same for the day before it.
 *
 * `offset` 1 = yesterday, 2 = the day before. Days are boundaried in the
 * operator's own timezone, not UTC — a game at 1am IST belongs to that day,
 * not to the previous one.
 */
async function dayStats(offset) {
  const { rows } = await query(`
    WITH d AS (
      -- offset 1 is YESTERDAY, not today. The email goes out in the morning
      -- about the day that just finished; reporting "today so far" at 8am
      -- would be a page of zeroes every single morning.
      SELECT ((now() AT TIME ZONE $2)::date - $1::int) AS day
    )
    SELECT
      to_char((SELECT day FROM d), 'DD Mon YYYY')                                    AS label,
      (SELECT count(*)::int FROM players p, d
        WHERE (p.created_at AT TIME ZONE $2)::date = d.day)                          AS new_players,
      -- "Active" means the person did something we can see: a tracked event,
      -- a message to the bot, or a seat in a game. Any one alone under-counts -
      -- tracked events are not written for every path, and a player who only
      -- played never has to message us again that day.
      (SELECT count(*)::int FROM (
         SELECT e.player_id FROM analytics_events e, d
          WHERE e.player_id IS NOT NULL AND (e.occurred_at AT TIME ZONE $2)::date = d.day
          UNION
         SELECT m.player_id FROM messages m, d
          WHERE m.direction = 'in' AND (m.created_at AT TIME ZONE $2)::date = d.day
          UNION
         SELECT gp.player_id FROM game_players gp JOIN games g ON g.id = gp.game_id, d
          WHERE (g.created_at AT TIME ZONE $2)::date = d.day
       ) act)                                                                        AS active_players,
      (SELECT count(DISTINCT g.host_player_id)::int FROM games g, d
        WHERE (g.created_at AT TIME ZONE $2)::date = d.day)                          AS hosts,
      (SELECT count(*)::int FROM games g, d
        WHERE (g.created_at AT TIME ZONE $2)::date = d.day)                          AS games_created,
      (SELECT count(*)::int FROM games g, d
        WHERE (g.started_at AT TIME ZONE $2)::date = d.day)                          AS games_started,
      (SELECT count(*)::int FROM games g, d
        WHERE g.status='finished' AND (g.ended_at AT TIME ZONE $2)::date = d.day)    AS games_finished,
      (SELECT count(*)::int FROM games g, d
        WHERE g.status='abandoned' AND (g.ended_at AT TIME ZONE $2)::date = d.day)   AS games_abandoned,
      (SELECT count(DISTINCT gp.player_id)::int FROM game_players gp
        JOIN games g ON g.id = gp.game_id, d
        WHERE (g.created_at AT TIME ZONE $2)::date = d.day)                          AS players_seated,
      -- Seats, not people. A person who played three games is three seats -
      -- dividing DISTINCT players by rooms would report 1.0 per room forever.
      (SELECT count(*)::int FROM game_players gp
        JOIN games g ON g.id = gp.game_id, d
        WHERE (g.created_at AT TIME ZONE $2)::date = d.day)                          AS seats,
      (SELECT count(*)::int FROM claims c, d
        WHERE c.status='awarded' AND (c.created_at AT TIME ZONE $2)::date = d.day)   AS prizes,
      (SELECT count(*)::int FROM messages m, d
        WHERE m.direction='in' AND (m.created_at AT TIME ZONE $2)::date = d.day)     AS msg_in,
      (SELECT count(*)::int FROM messages m, d
        WHERE m.direction='out' AND (m.created_at AT TIME ZONE $2)::date = d.day)    AS msg_out,
      (SELECT count(*)::int FROM messages m, d
        WHERE m.direction='out' AND m.status='failed'
          AND (m.created_at AT TIME ZONE $2)::date = d.day)                          AS msg_failed,
      (SELECT count(*)::int FROM feedback f, d
        WHERE (f.created_at AT TIME ZONE $2)::date = d.day)                          AS feedback,
      (SELECT round(avg(f.rating)::numeric, 1) FROM feedback f, d
        WHERE f.rating IS NOT NULL AND (f.created_at AT TIME ZONE $2)::date = d.day) AS avg_rating,
      (SELECT count(*)::int FROM support_tickets t, d
        WHERE (t.created_at AT TIME ZONE $2)::date = d.day)                          AS tickets_opened,
      (SELECT count(*)::int FROM board_sessions b, d
        WHERE (b.first_seen_at AT TIME ZONE $2)::date = d.day)                       AS board_sessions,
      (SELECT count(*)::int FROM draw_answers a, d
        WHERE a.answer <> 'no_response'
          AND (a.answered_at AT TIME ZONE $2)::date = d.day)                         AS answers
  `, [offset, TZ]);
  return rows[0];
}

/** Standing totals - things that are true right now, not "yesterday". */
async function standing() {
  const { rows } = await query(`
    SELECT
      (SELECT count(*)::int FROM players)                                       AS total_players,
      (SELECT count(*)::int FROM games)                                         AS total_games,
      (SELECT count(*)::int FROM support_tickets
        WHERE status IN ('open','in_progress'))                                 AS tickets_open,
      (SELECT count(*)::int FROM support_tickets
        WHERE status IN ('open','in_progress')
          AND created_at < now() - interval '24 hours')                         AS tickets_stale,
      (SELECT count(*)::int FROM games WHERE status='lobby')                    AS lobbies_waiting,
      (SELECT count(*)::int FROM games WHERE status='running')                  AS games_running,
      (SELECT count(*)::int FROM feedback WHERE approved_at IS NULL
                                            AND comment IS NOT NULL)            AS comments_unapproved
  `);
  return rows[0];
}

/**
 * Where yesterday's players opened their boards.
 *
 * States and cities separately, because they answer different questions: the
 * state list says which markets are alive, the city list says whether a state
 * is really one neighbourhood. "State" includes union territories - Delhi and
 * Puducherry arrive in the same field as Karnataka and are treated the same.
 *
 * Only board visits appear here. A player who stayed in WhatsApp has no
 * address for us to resolve, so the totals here are legitimately lower than
 * the player counts above; the line below says so rather than leaving the gap
 * looking like lost data.
 */
async function geography(offset) {
  const args = [offset, TZ];
  const byCol = async (col) => (await query(`
    WITH d AS (SELECT ((now() AT TIME ZONE $2)::date - $1::int) AS day)
    SELECT coalesce(nullif(b.${col}, ''), 'unknown') AS name,
           count(DISTINCT b.player_id)::int          AS players
      FROM board_sessions b, d
     WHERE (b.first_seen_at AT TIME ZONE $2)::date = d.day
     GROUP BY 1
     ORDER BY players DESC, name
     LIMIT 8
  `, args)).rows;

  const [states, cities, totals] = await Promise.all([
    byCol('region'),
    byCol('city'),
    query(`
      WITH d AS (SELECT ((now() AT TIME ZONE $2)::date - $1::int) AS day)
      SELECT count(DISTINCT b.player_id)::int AS located,
             count(DISTINCT b.ip)::int        AS addresses
        FROM board_sessions b, d
       WHERE (b.first_seen_at AT TIME ZONE $2)::date = d.day
         AND b.city IS NOT NULL
    `, args).then((r) => r.rows[0]),
  ]);
  return { states, cities, ...totals };
}

/**
 * "12 (+50%)" — or "12 (new)" when there is nothing to compare against.
 *
 * Returning "+100%" for 0 → 12 would be arithmetically defensible and
 * completely useless; "new" is what a person actually means.
 */
function delta(now, before) {
  const n = Number(now) || 0;
  const b = Number(before) || 0;
  if (b === 0) return n === 0 ? `${n}` : `${n}  (new)`;
  if (n === b) return `${n}  (no change)`;
  const pct = Math.round(((n - b) / b) * 100);
  return `${n}  (${pct > 0 ? '+' : ''}${pct}%)`;
}

const pad = (label) => (label + ' ').padEnd(26, '.');

/** Turns the geography rows into lines, or says plainly that there are none. */
function geoSection(geo) {
  if (!geo.located) {
    return ['  No board was opened yesterday, so there is nothing to locate.'];
  }
  const rows = (list) =>
    list.map((r) => `  ${pad('  ' + r.name)} ${r.players}`);

  return [
    `  ${pad('Players located')} ${geo.located}   (from ${geo.addresses} address${geo.addresses === 1 ? '' : 'es'})`,
    '',
    '  State / union territory',
    ...rows(geo.states),
    '',
    '  City',
    ...rows(geo.cities),
    '',
    '  Approximate - resolved from the IP the board was opened from. On mobile',
    '  data this is the carrier gateway, so treat it as a hint, not a fact.',
  ];
}

export async function buildDailySummary() {
  const [today, before, now, geo] = await Promise.all([dayStats(1), dayStats(2), standing(), geography(1)]);

  const rate = (a, b) => (Number(b) ? Math.round((Number(a) / Number(b)) * 100) : 0);

  const lines = [
    `${config.brandName} — daily summary`,
    `${today.label}   (compared with the day before)`,
    '',
    'PEOPLE',
    `  ${pad('New players')} ${delta(today.new_players, before.new_players)}`,
    `  ${pad('Active players')} ${delta(today.active_players, before.active_players)}`,
    `  ${pad('Players seated in a game')} ${delta(today.players_seated, before.players_seated)}`,
    `  ${pad('Hosts who ran a game')} ${delta(today.hosts, before.hosts)}`,
    '',
    'GAMES',
    `  ${pad('Rooms created')} ${delta(today.games_created, before.games_created)}`,
    `  ${pad('Games started')} ${delta(today.games_started, before.games_started)}`,
    `  ${pad('Games finished')} ${delta(today.games_finished, before.games_finished)}`,
    `  ${pad('Games abandoned')} ${delta(today.games_abandoned, before.games_abandoned)}`,
    `  ${pad('Prizes won')} ${delta(today.prizes, before.prizes)}`,
    '',
    'ENGAGEMENT',
    `  ${pad('Numbers answered')} ${delta(today.answers, before.answers)}`,
    `  ${pad('Boards opened')} ${delta(today.board_sessions, before.board_sessions)}`,
    `  ${pad('Feedback left')} ${delta(today.feedback, before.feedback)}`,
    `  ${pad('Average rating')} ${today.avg_rating ?? '—'}${before.avg_rating ? `  (was ${before.avg_rating})` : ''}`,
    '',
    'MESSAGES',
    `  ${pad('Received')} ${delta(today.msg_in, before.msg_in)}`,
    `  ${pad('Sent')} ${delta(today.msg_out, before.msg_out)}`,
    `  ${pad('Failed to send')} ${delta(today.msg_failed, before.msg_failed)}`,
    '',
    'CONVERSION',
    `  ${pad('Rooms that got started')} ${rate(today.games_started, today.games_created)}%`,
    `  ${pad('Games that finished')} ${rate(today.games_finished, today.games_started)}%`,
    `  ${pad('Players per room')} ${today.games_created ? (today.seats / today.games_created).toFixed(1) : '—'}`,
    '',
    'WHERE THEY PLAYED FROM',
    ...geoSection(geo),
    '',
    'RIGHT NOW',
    `  ${pad('Total players ever')} ${now.total_players}`,
    `  ${pad('Total games ever')} ${now.total_games}`,
    `  ${pad('Games running')} ${now.games_running}`,
    `  ${pad('Rooms waiting to start')} ${now.lobbies_waiting}`,
    `  ${pad('Support tickets open')} ${now.tickets_open}`,
  ];

  // Only worth a line when it is actually a problem.
  if (now.tickets_stale > 0) {
    lines.push(`  ${pad('  ...open over 24h')} ${now.tickets_stale}   <-- needs a reply`);
  }
  if (now.comments_unapproved > 0) {
    lines.push(`  ${pad('Comments awaiting approval')} ${now.comments_unapproved}`);
  }

  // A short verdict, so the email is useful even if only the top is read.
  const notes = [];
  if (Number(today.msg_failed) > 0) notes.push(`${today.msg_failed} message(s) failed to send — check the WhatsApp token.`);
  if (Number(today.games_abandoned) > 0) notes.push(`${today.games_abandoned} game(s) were abandoned.`);
  if (now.tickets_stale > 0) notes.push(`${now.tickets_stale} support ticket(s) have been open over a day.`);
  if (Number(today.games_created) > 0 && Number(today.games_started) === 0) {
    notes.push('Rooms were created but none were started — hosts are not getting players in.');
  }
  if (Number(today.new_players) === 0 && Number(today.active_players) === 0) {
    notes.push('No activity at all yesterday.');
  }

  lines.push('', 'WORTH A LOOK');
  lines.push(...(notes.length ? notes.map((n) => `  • ${n}`) : ['  • Nothing needs your attention.']));

  lines.push('', `${config.brandName} · ${config.publicRoot}`);

  return {
    // Same convention as every other alert: the company is the sender name.
    subject: `📊 ${config.brandName} — daily summary, ${today.label}`,
    body: lines.join('\n'),
    stats: { today, before, now },
  };
}

/** Has it already gone out for this date? */
async function alreadySentToday() {
  const { rows } = await query(
    `SELECT 1 FROM notification_log
      WHERE kind = 'daily'
        AND (sent_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
      LIMIT 1`,
    [TZ],
  );
  return rows.length > 0;
}

/**
 * @param {boolean} force send even if today's has already gone, and even if
 *        the trigger is switched off. Used by the "send now" button.
 */
export async function sendDailySummary({ force = false } = {}) {
  if (!force) {
    if (!config.alerts.enabled) return { sent: false, reason: 'alerts are disabled' };

    const { rows } = await query(
      `SELECT mode FROM notification_settings WHERE trigger_key = 'daily.summary'`,
    );
    if ((rows[0]?.mode ?? 'digest') === 'off') return { sent: false, reason: 'daily summary is switched off' };

    if (await alreadySentToday()) return { sent: false, reason: 'already sent today' };
  }

  const { subject, body } = await buildDailySummary();
  const result = await sendMail({ to: config.alerts.recipient, subject, text: body });

  await query(
    `INSERT INTO notification_log (kind, subject, recipient, event_count, ok, error)
          VALUES ('daily', $1, $2, 1, $3, $4)`,
    [subject, config.alerts.recipient, result.sent, result.error ?? null],
  );

  log.info('daily summary', { ok: result.sent, to: config.alerts.recipient });
  return { sent: result.sent, subject, error: result.error ?? null };
}

/**
 * Fires once, shortly after the configured hour.
 *
 * Checked every fifteen minutes rather than scheduled precisely: a cron-style
 * schedule would miss the slot entirely if the process happened to be
 * restarting at that minute, and alreadySentToday() makes a late check
 * harmless.
 */
export function startDailySummary() {
  const check = async () => {
    try {
      const hour = Number(
        new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: TZ })
          .format(new Date()),
      );
      if (hour < config.alerts.dailyHour) return;
      await sendDailySummary();
    } catch (err) {
      log.error('daily summary check failed', { message: err.message });
    }
  };

  const timer = setInterval(check, 15 * 60_000);
  timer.unref();
  // Catch up immediately if the server was down at the scheduled hour.
  setTimeout(check, 20_000).unref();
  log.info('daily summary scheduled', { hour: config.alerts.dailyHour, tz: TZ });
}
