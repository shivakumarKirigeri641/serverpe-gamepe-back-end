/**
 * Live operations: what is happening right now, how it compares, and whether
 * every part of the system is actually working.
 *
 * ── Why this is a new module rather than more of admin-data.service.js ────
 *
 * That file answers questions about the past - days, weeks, funnels - and it
 * is already 1,400 lines. Everything here is about the present minute and has
 * a different shape: small queries, called often, by a page that polls. Mixing
 * them would mean a dashboard refresh competing with a month-long aggregate
 * for the same connection.
 *
 * ── Minute buckets are built in SQL, not in the browser ───────────────────
 *
 * LiveCharts used to assemble its window client-side, appending one point per
 * poll. That gives a chart that is empty on arrival and loses everything on
 * reload - so an operator who refreshes to check something has to sit and
 * watch it fill again, and nobody can ever see the ten minutes before they
 * opened the page. The series is generated server-side from the event log, so
 * it has history the moment it loads.
 *
 * ── One honest caveat, visible in the output ──────────────────────────────
 *
 * `board.opened` is written roughly once per second per open board - it is the
 * board polling for state, not a person doing something. Left in the totals it
 * swamps every real signal by two orders of magnitude. So it is reported as
 * its own series, `boardPolls`, and excluded from `events`. The number is
 * genuinely useful - it is the best proxy for "boards currently open" - but
 * calling it activity would be a lie.
 */
import { query } from "../db/pool.js";
import { config } from "../config/env.js";
import { log } from "../utils/logger.js";
import { listenerCount } from "./live.service.js";
import { smsReady } from "./sms.service.js";
import { playChannel, bakraEnabled, maintenance } from "./settings.service.js";
import { pool } from "../db/pool.js";

/** Poll-driven endpoints must never be the reason a page hangs. */
const BUCKET_LIMIT = 720; // 12 hours of minutes

/**
 * Per-minute activity for the last N minutes, gap-filled.
 *
 * Gap-filling matters more than it sounds: without it a quiet minute is a
 * MISSING point rather than a zero, and a line chart joins across the hole -
 * drawing a smooth slope through an outage instead of a floor.
 */
export async function minuteSeries({ minutes = 120 } = {}) {
  const span = Math.min(Math.max(Number(minutes) || 120, 5), BUCKET_LIMIT);

  const { rows } = await query(
    `
    WITH buckets AS (
      SELECT generate_series(
               date_trunc('minute', now()) - make_interval(mins => $1::int - 1),
               date_trunc('minute', now()),
               '1 minute'
             ) AS minute
    ),
    ev AS (
      SELECT date_trunc('minute', occurred_at) AS minute,
             count(*) FILTER (WHERE event_type <> 'board.opened')      AS events,
             count(*) FILTER (WHERE event_type = 'board.opened')       AS board_polls,
             count(DISTINCT player_id)                                 AS players,
             count(*) FILTER (WHERE event_type = 'player.signed_in'
                                 OR event_type = 'player.registered')  AS sign_ins,
             count(*) FILTER (WHERE event_type = 'game.created')        AS games_created,
             count(*) FILTER (WHERE event_type = 'game.joined')         AS joins,
             count(*) FILTER (WHERE event_type = 'game.started')        AS games_started,
             count(*) FILTER (WHERE event_type = 'claim.awarded')       AS claims
        FROM analytics_events
       WHERE occurred_at >= date_trunc('minute', now()) - make_interval(mins => $1::int)
       GROUP BY 1
    ),
    dr AS (
      SELECT date_trunc('minute', drawn_at) AS minute, count(*) AS draws
        FROM draws
       WHERE drawn_at >= date_trunc('minute', now()) - make_interval(mins => $1::int)
       GROUP BY 1
    ),
    ans AS (
      SELECT date_trunc('minute', answered_at) AS minute, count(*) AS answers
        FROM draw_answers
       WHERE answered_at >= date_trunc('minute', now()) - make_interval(mins => $1::int)
       GROUP BY 1
    )
    SELECT to_char(b.minute, 'YYYY-MM-DD"T"HH24:MI')  AS t,
           to_char(b.minute, 'HH24:MI')               AS label,
           coalesce(ev.events, 0)::int                AS events,
           coalesce(ev.board_polls, 0)::int           AS "boardPolls",
           coalesce(ev.players, 0)::int               AS players,
           coalesce(ev.sign_ins, 0)::int              AS "signIns",
           coalesce(ev.games_created, 0)::int         AS "gamesCreated",
           coalesce(ev.joins, 0)::int                 AS joins,
           coalesce(ev.games_started, 0)::int         AS "gamesStarted",
           coalesce(ev.claims, 0)::int                AS claims,
           coalesce(dr.draws, 0)::int                 AS draws,
           coalesce(ans.answers, 0)::int              AS answers
      FROM buckets b
      LEFT JOIN ev  ON ev.minute  = b.minute
      LEFT JOIN dr  ON dr.minute  = b.minute
      LEFT JOIN ans ON ans.minute = b.minute
     ORDER BY b.minute
    `,
    [span],
  );

  return { minutes: span, points: rows };
}

/**
 * The same clock time today, yesterday, and this day last week.
 *
 * ── Why aligned to time-of-day rather than plotted as three date ranges ──
 *
 * "Versus yesterday" is only meaningful at the same hour. A total-so-far
 * comparison says today is down 90% at 9am, every single morning, because
 * yesterday's figure is a whole day and today's is nine hours. These three
 * series share an x-axis of hour-of-day, so 9pm sits above 9pm and the shape
 * of an evening is comparable.
 *
 * Buckets are 15 minutes: fine enough to see a game night begin, coarse
 * enough that a quiet product does not look like noise.
 */
export async function todayVsBefore() {
  const { rows } = await query(`
    WITH slots AS (
      SELECT generate_series(0, 95) AS slot      -- 96 x 15 minutes
    ),
    tz AS (SELECT $1::text AS zone),
    base AS (
      SELECT (now() AT TIME ZONE (SELECT zone FROM tz))::date AS today
    ),
    ev AS (
      SELECT
        ((e.occurred_at AT TIME ZONE (SELECT zone FROM tz))::date) AS day,
        (extract(hour FROM (e.occurred_at AT TIME ZONE (SELECT zone FROM tz))) * 4
          + floor(extract(minute FROM (e.occurred_at AT TIME ZONE (SELECT zone FROM tz))) / 15))::int AS slot,
        count(*) FILTER (WHERE e.event_type <> 'board.opened') AS events,
        count(DISTINCT e.player_id) AS players
      FROM analytics_events e, base
      WHERE (e.occurred_at AT TIME ZONE (SELECT zone FROM tz))::date
            IN (base.today, base.today - 1, base.today - 7)
      GROUP BY 1, 2
    )
    SELECT s.slot,
           lpad(((s.slot * 15) / 60)::text, 2, '0') || ':' ||
             lpad(((s.slot * 15) % 60)::text, 2, '0')            AS label,
           coalesce(t.events, 0)::int   AS "todayEvents",
           coalesce(y.events, 0)::int   AS "yesterdayEvents",
           coalesce(w.events, 0)::int   AS "lastWeekEvents",
           coalesce(t.players, 0)::int  AS "todayPlayers",
           coalesce(y.players, 0)::int  AS "yesterdayPlayers",
           coalesce(w.players, 0)::int  AS "lastWeekPlayers"
      FROM slots s
      CROSS JOIN base
      LEFT JOIN ev t ON t.slot = s.slot AND t.day = base.today
      LEFT JOIN ev y ON y.slot = s.slot AND y.day = base.today - 1
      LEFT JOIN ev w ON w.slot = s.slot AND w.day = base.today - 7
     ORDER BY s.slot
  `, [config.timezone]);

  // Only up to the current slot for today: drawing the rest as zeros would
  // show a cliff every time somebody looks at the chart before midnight.
  const now = new Date();
  const currentSlot = now.getHours() * 4 + Math.floor(now.getMinutes() / 15);
  const points = rows.map((r) => ({
    ...r,
    todayEvents: r.slot <= currentSlot ? r.todayEvents : null,
    todayPlayers: r.slot <= currentSlot ? r.todayPlayers : null,
  }));

  const sum = (k, upTo = 95) =>
    rows.reduce((n, r) => (r.slot <= upTo ? n + Number(r[k] || 0) : n), 0);

  return {
    points,
    currentSlot,
    /**
     * Totals compared at the SAME point in the day, which is the only
     * comparison that means anything before midnight.
     */
    sameTimeOfDay: {
      events: {
        today: sum("todayEvents", currentSlot),
        yesterday: sum("yesterdayEvents", currentSlot),
        lastWeek: sum("lastWeekEvents", currentSlot),
      },
      players: {
        today: sum("todayPlayers", currentSlot),
        yesterday: sum("yesterdayPlayers", currentSlot),
        lastWeek: sum("lastWeekPlayers", currentSlot),
      },
    },
    /** And the whole of each previous day, for context. */
    fullDay: {
      yesterdayEvents: sum("yesterdayEvents"),
      lastWeekEvents: sum("lastWeekEvents"),
    },
  };
}

/**
 * Pin to pin: every dependency, and every stage a player has to get through.
 *
 * Two halves, because "is it up" and "does it work" are different questions
 * and a dashboard that only answers the first is how an outage lasts a day.
 *
 *   dependencies - can we reach the things we need, and how fast
 *   journey      - of the people who started, how many got to each next step
 *
 * Every check reports ok / warn / fail with a reason a human can act on. No
 * check is allowed to throw: this endpoint is what gets opened when something
 * is already wrong, and it has to render then most of all.
 */
export async function pinToPin({ hours = 24 } = {}) {
  const span = Math.min(Math.max(Number(hours) || 24, 1), 24 * 30);
  const checks = [];

  const add = (name, status, detail, extra = {}) =>
    checks.push({ name, status, detail, ...extra });

  // --- database ------------------------------------------------------------
  try {
    const t0 = Date.now();
    await query("SELECT 1");
    const ms = Date.now() - t0;
    add("Database", ms < 150 ? "ok" : ms < 1000 ? "warn" : "fail",
      `round trip ${ms}ms`, { latencyMs: ms });
  } catch (err) {
    add("Database", "fail", err.message);
  }

  // --- connection pool -----------------------------------------------------
  try {
    const waiting = pool.waitingCount;
    add("Connection pool",
      waiting === 0 ? "ok" : waiting < 5 ? "warn" : "fail",
      `${pool.totalCount} open, ${pool.idleCount} idle, ${waiting} waiting`,
      { total: pool.totalCount, idle: pool.idleCount, waiting });
  } catch (err) {
    add("Connection pool", "warn", err.message);
  }

  // --- database size, so disk never surprises anyone -----------------------
  try {
    const { rows } = await query(
      "SELECT pg_size_pretty(pg_database_size(current_database())) AS size, pg_database_size(current_database()) AS bytes",
    );
    add("Database size", "ok", rows[0].size, { bytes: Number(rows[0].bytes) });
  } catch (err) {
    add("Database size", "warn", err.message);
  }

  // --- the draw scheduler --------------------------------------------------
  try {
    const { rows } = await query(`
      SELECT count(*) FILTER (WHERE status = 'running')::int AS running,
             count(*) FILTER (WHERE status = 'running' AND next_draw_at < now() - interval '30 seconds')::int AS overdue,
             max(extract(epoch FROM (now() - next_draw_at)))::int AS worst_lag
        FROM games
    `);
    const { running, overdue, worst_lag } = rows[0];
    add("Draw scheduler",
      overdue === 0 ? "ok" : "fail",
      running === 0
        ? "no games running"
        : `${running} running, ${overdue} overdue` + (overdue ? ` (worst ${worst_lag}s late)` : ""),
      { running, overdue });
  } catch (err) {
    add("Draw scheduler", "fail", err.message);
  }

  // --- live streams --------------------------------------------------------
  try {
    const { rows } = await query(
      "SELECT id FROM games WHERE status IN ('lobby','running') ORDER BY id DESC LIMIT 50",
    );
    const listeners = rows.reduce((n, g) => n + listenerCount(g.id), 0);
    add("Live streams (SSE)", "ok",
      `${listeners} board${listeners === 1 ? "" : "s"} connected across ${rows.length} open game${rows.length === 1 ? "" : "s"}`,
      { listeners, openGames: rows.length });
  } catch (err) {
    add("Live streams (SSE)", "warn", err.message);
  }

  // --- sign-in, which is now the only way in -------------------------------
  const ready = smsReady();
  add("Sign-in (SMS)", ready ? "ok" : "fail",
    ready
      ? `${config.otp.provider}, route ${config.otp.route || "n/a"}`
      : `${config.otp.provider} is not able to send - nobody can sign in`,
    { provider: config.otp.provider });

  if (config.otp.provider === "fast2sms" && config.otp.apiKey) {
    try {
      const res = await fetch("https://www.fast2sms.com/dev/wallet", {
        headers: { authorization: config.otp.apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(6000),
      });
      const body = await res.json();
      const credits = Number(body?.sms_count ?? 0);
      add("SMS credits",
        credits > 200 ? "ok" : credits > 0 ? "warn" : "fail",
        `${credits} messages (wallet ${body?.wallet ?? "?"})`,
        { credits });
    } catch (err) {
      // A provider we cannot reach is not necessarily a provider that is
      // down - say so rather than declaring an outage from one timeout.
      add("SMS credits", "warn", "could not read the balance: " + err.message);
    }
  }

  // --- recent OTP health, which is the real test of sign-in ----------------
  try {
    const { rows } = await query(`
      SELECT count(*)::int AS requested,
             count(*) FILTER (WHERE consumed_at IS NOT NULL)::int AS used,
             count(*) FILTER (WHERE consumed_at IS NULL AND expires_at < now())::int AS expired
        FROM otp_requests
       WHERE created_at > now() - make_interval(hours => $1::int)
    `, [span]);
    const { requested, used, expired } = rows[0];
    const rate = requested ? Math.round((used / requested) * 100) : null;
    add("Codes actually used",
      requested === 0 ? "ok" : rate >= 60 ? "ok" : rate >= 30 ? "warn" : "fail",
      requested === 0
        ? `no sign-in attempts in ${span}h`
        : `${used} of ${requested} codes used (${rate}%), ${expired} expired unused`,
      { requested, used, expired, rate });
  } catch (err) {
    add("Codes actually used", "warn", err.message);
  }

  // --- mail ----------------------------------------------------------------
  add("Operator mail", config.mail.host ? "ok" : "warn",
    config.mail.host ? `${config.mail.host}:${config.mail.port}` : "not configured - no alerts or daily summary");

  // --- configuration sanity ------------------------------------------------
  const play = playChannel();
  add("Play channel", play.webEnabled ? "ok" : "fail",
    `${play.mode}` + (play.webEnabled ? "" : " - the web entrance is closed"),
    { mode: play.mode });

  const mt = maintenance();
  add("Maintenance mode", mt.active ? "warn" : "ok",
    mt.active ? "ON - players are being turned away" : "off");

  add("Public base URL",
    config.publicBaseUrl && !/localhost|127\.0\.0\.1/.test(config.publicBaseUrl) ? "ok" : "warn",
    config.publicBaseUrl || "not set - links handed to players will be broken");

  // --- the journey ---------------------------------------------------------
  let journey = [];
  // Reported to the page rather than only logged. An empty section looks like
  // "nothing happened today"; this says "this pane is broken", which is a
  // different thing and the only one an operator can act on.
  let journeyError = null;
  try {
    const { rows } = await query(`
      WITH w AS (SELECT now() - make_interval(hours => $1::int) AS since)
      SELECT
        (SELECT count(DISTINCT player_id) FROM analytics_events, w
          WHERE occurred_at > w.since
            AND event_type IN ('player.signed_in','player.registered'))        AS signed_in,
        (SELECT count(*) FROM games, w WHERE created_at > w.since)              AS rooms_made,
        (SELECT count(*) FROM game_players gp JOIN games g ON g.id = gp.game_id, w
          WHERE gp.joined_at > w.since)                                         AS seated,
        -- board_sessions records when a board was FIRST seen, not "started":
        -- the column is first_seen_at. Using started_at here returned nothing
        -- at all and the whole journey section rendered empty.
        (SELECT count(DISTINCT (game_id, player_id)) FROM board_sessions, w
          WHERE first_seen_at > w.since)                                        AS boards_opened,
        (SELECT count(*) FROM games, w
          WHERE created_at > w.since AND status IN ('running','finished'))      AS started,
        (SELECT count(*) FROM games, w
          WHERE created_at > w.since AND status = 'finished')                   AS finished,
        (SELECT count(*) FROM claims, w WHERE created_at > w.since)             AS prizes_won
    `, [span]);

    const r = rows[0];
    const stage = (label, value, of, note) => ({
      label,
      value: Number(value),
      of: of === null ? null : Number(of),
      percent: of ? Math.round((Number(value) / Number(of)) * 100) : null,
      note,
    });

    journey = [
      stage("Signed in", r.signed_in, null, "distinct players who got through sign-in"),
      stage("Rooms created", r.rooms_made, null, "hosts who made a room"),
      stage("Players seated", r.seated, null, "took a seat in a room"),
      stage("Boards opened", r.boards_opened, r.seated, "seated AND actually opened the board"),
      stage("Games started", r.started, r.rooms_made, "rooms that reached the first number"),
      stage("Games finished", r.finished, r.started, "started AND played to the end"),
      stage("Prizes won", r.prizes_won, null, "validated claims"),
    ];
  } catch (err) {
    journeyError = err.message;
    log.error("pin-to-pin journey query failed", { message: err.message });
  }

  const worst = checks.reduce(
    (acc, c) => (c.status === "fail" ? "fail" : c.status === "warn" && acc !== "fail" ? "warn" : acc),
    "ok",
  );

  return {
    status: worst,
    checkedAt: new Date().toISOString(),
    hours: span,
    version: config.brandName,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    games: { bakra: bakraEnabled() },
    checks,
    journey,
    journeyError,
  };
}

/**
 * Everything the live page needs in one request.
 *
 * One call rather than four, because the page polls: four requests per tick
 * is four times the connections and four chances for the panes to disagree
 * with each other by a second.
 */
export async function liveOps({ minutes = 120, hours = 24 } = {}) {
  const [series, compare, health] = await Promise.all([
    minuteSeries({ minutes }),
    todayVsBefore(),
    pinToPin({ hours }),
  ]);
  return { series, compare, health };
}
