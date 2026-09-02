/**
 * Where players are, and which way each place is moving.
 *
 * The panel and the morning email both ask the same two questions of the same
 * data, so they ask it here rather than each writing their own SQL:
 *
 *   1. Which states and cities are people playing from?
 *   2. Is each of those growing or shrinking?
 *
 * ── What "a player from Karnataka" actually means ───────────────────────────
 *
 * Location is resolved from the IP the BOARD was opened from. Nothing here
 * comes from a browser permission prompt, and nothing comes from WhatsApp -
 * Meta relays those messages, so a player who never opens a board has no
 * address for us to read and is invisible to every number on this page. That
 * is a property of the transport, not a gap to be fixed, and `coverage()`
 * exists so the panel can say so out loud instead of quietly under-reporting.
 *
 * On mobile data the address is the carrier's gateway. In practice that is
 * usually the right state and often the wrong city, which is why the state
 * list is the one worth making decisions on and the city list is context.
 *
 * ── Why the comparison is a whole period back, not a rolling window ─────────
 *
 * Comparing "the last 7 days" with "the 7 days before that" is stable against
 * the weekly rhythm this platform has - people play in the evening and at the
 * weekend. A day-on-day comparison of a Sunday against a Monday would report a
 * collapse every single week and mean nothing.
 *
 * Union territories need no special handling: providers return Delhi,
 * Puducherry and Chandigarh in the same field as Karnataka, and so do we. The
 * label says "state / union territory" so nobody has to wonder.
 */
import { query } from '../db/pool.js';

const TZ = 'Asia/Kolkata';

/** How many days one period covers. */
const PERIODS = {
  day: 1,
  week: 7,
  month: 30,
};

export function periodDays(period) {
  return PERIODS[period] ?? PERIODS.week;
}

/**
 * "+50%", "-20%", "new", or "gone" - whichever is honest.
 *
 * A percentage against zero is arithmetically infinite and practically
 * useless, so the two edges get words instead of numbers.
 */
function movement(now, before) {
  const n = Number(now) || 0;
  const b = Number(before) || 0;
  if (b === 0 && n === 0) return { pct: null, label: '—', direction: 'flat' };
  if (b === 0) return { pct: null, label: 'new', direction: 'up' };
  if (n === 0) return { pct: -100, label: 'gone', direction: 'down' };
  const pct = Math.round(((n - b) / b) * 100);
  return {
    pct,
    label: `${pct > 0 ? '+' : ''}${pct}%`,
    direction: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat',
  };
}

/**
 * One place list - by state or by city - for this period and the last.
 *
 * Counted as DISTINCT players, not sessions: a person who reloads their board
 * eleven times is one player in Bengaluru, not eleven.
 */
async function placesBy(column, days, limit) {
  const { rows } = await query(`
    WITH bounds AS (
      SELECT ((now() AT TIME ZONE $1)::date - ($2::int - 1))     AS this_from,
             ((now() AT TIME ZONE $1)::date - ($2::int * 2 - 1)) AS prev_from,
             ((now() AT TIME ZONE $1)::date - $2::int)           AS prev_to
    ),
    seen AS (
      SELECT coalesce(nullif(b.${column}, ''), 'Unknown')  AS name,
             b.player_id,
             (b.first_seen_at AT TIME ZONE $1)::date       AS day
        FROM board_sessions b, bounds
       WHERE (b.first_seen_at AT TIME ZONE $1)::date >= bounds.prev_from
    )
    SELECT s.name,
           count(DISTINCT s.player_id) FILTER (
             WHERE s.day >= (SELECT this_from FROM bounds))::int AS players,
           count(DISTINCT s.player_id) FILTER (
             WHERE s.day >= (SELECT prev_from FROM bounds)
               AND s.day <= (SELECT prev_to   FROM bounds))::int AS players_before
      FROM seen s
     GROUP BY s.name
     ORDER BY players DESC, s.name
     LIMIT $3
  `, [TZ, days, limit]);

  return rows.map((r) => ({
    name: r.name,
    players: r.players,
    playersBefore: r.players_before,
    change: r.players - r.players_before,
    ...movement(r.players, r.players_before),
  }));
}

/**
 * The daily shape of each of the top places, for a sparkline.
 *
 * Returned as one row per place with an array of counts oldest-first, so the
 * panel can draw it without reshaping anything.
 */
async function trendFor(column, names, days) {
  if (!names.length) return {};
  const span = Math.max(days * 2, 14);
  const { rows } = await query(`
    WITH days AS (
      SELECT generate_series(
        (now() AT TIME ZONE $1)::date - ($3::int - 1),
        (now() AT TIME ZONE $1)::date,
        interval '1 day')::date AS day
    )
    SELECT p.name, d.day,
           count(DISTINCT b.player_id)::int AS players
      FROM days d
      CROSS JOIN unnest($2::text[]) AS p(name)
      LEFT JOIN board_sessions b
             ON coalesce(nullif(b.${column}, ''), 'Unknown') = p.name
            AND (b.first_seen_at AT TIME ZONE $1)::date = d.day
     GROUP BY p.name, d.day
     ORDER BY p.name, d.day
  `, [TZ, names, span]);

  const out = {};
  for (const r of rows) (out[r.name] ??= []).push(r.players);
  return out;
}

/**
 * How much of the player base this page can actually see.
 *
 * Without this the panel would show "43 players in Karnataka" next to a
 * dashboard saying 300 players and look broken. It is not broken - it is the
 * difference between everyone, and everyone who opened a board.
 */
async function coverage(days) {
  const { rows } = await query(`
    WITH bounds AS (
      SELECT ((now() AT TIME ZONE $1)::date - ($2::int - 1)) AS this_from
    )
    SELECT
      (SELECT count(DISTINCT b.player_id)::int FROM board_sessions b, bounds
        WHERE (b.first_seen_at AT TIME ZONE $1)::date >= bounds.this_from)      AS opened_board,
      (SELECT count(DISTINCT b.player_id)::int FROM board_sessions b, bounds
        WHERE (b.first_seen_at AT TIME ZONE $1)::date >= bounds.this_from
          AND b.city IS NOT NULL AND b.city <> '')                              AS located,
      (SELECT count(DISTINCT gp.player_id)::int
         FROM game_players gp JOIN games g ON g.id = gp.game_id, bounds
        WHERE (g.created_at AT TIME ZONE $1)::date >= bounds.this_from)         AS played
  `, [TZ, days]);
  return rows[0];
}

/** The overall player trend, so the places have something to be a share of. */
async function totals(days) {
  const { rows } = await query(`
    WITH bounds AS (
      SELECT ((now() AT TIME ZONE $1)::date - ($2::int - 1))     AS this_from,
             ((now() AT TIME ZONE $1)::date - ($2::int * 2 - 1)) AS prev_from,
             ((now() AT TIME ZONE $1)::date - $2::int)           AS prev_to
    )
    SELECT
      (SELECT count(DISTINCT b.player_id)::int FROM board_sessions b, bounds
        WHERE (b.first_seen_at AT TIME ZONE $1)::date >= bounds.this_from)      AS players,
      (SELECT count(DISTINCT b.player_id)::int FROM board_sessions b, bounds
        WHERE (b.first_seen_at AT TIME ZONE $1)::date >= bounds.prev_from
          AND (b.first_seen_at AT TIME ZONE $1)::date <= bounds.prev_to)        AS players_before
  `, [TZ, days]);
  const r = rows[0];
  return { players: r.players, playersBefore: r.players_before, ...movement(r.players, r.players_before) };
}

/**
 * Everything the panel's geography section needs, in one round trip.
 *
 * @param {'day'|'week'|'month'} period  what one bar covers, and what the
 *        comparison is against.
 */
export async function geographyReport({ period = 'week', limit = 12 } = {}) {
  const days = periodDays(period);

  const [states, cities, cover, total] = await Promise.all([
    placesBy('region', days, limit),
    placesBy('city', days, limit),
    coverage(days),
    totals(days),
  ]);

  const [stateTrend, cityTrend] = await Promise.all([
    trendFor('region', states.slice(0, 6).map((s) => s.name), days),
    trendFor('city', cities.slice(0, 6).map((c) => c.name), days),
  ]);

  const withShare = (list) =>
    list.map((p) => ({
      ...p,
      share: total.players ? Math.round((p.players / total.players) * 100) : 0,
    }));

  // The headline: what actually moved. Places seen fewer than three times are
  // excluded - "1 player became 2" is a 100% rise and tells you nothing.
  const meaningful = states.filter((s) => Math.max(s.players, s.playersBefore) >= 3);
  const rising = [...meaningful].filter((s) => s.change > 0)
    .sort((a, b) => b.change - a.change || (b.pct ?? 0) - (a.pct ?? 0)).slice(0, 3);
  const falling = [...meaningful].filter((s) => s.change < 0)
    .sort((a, b) => a.change - b.change).slice(0, 3);

  return {
    period,
    days,
    total,
    coverage: {
      ...cover,
      // The share of players we can place at all. The honest denominator is
      // people who played, not people who exist.
      percentLocated: cover.played ? Math.round((cover.located / cover.played) * 100) : 0,
    },
    states: withShare(states),
    cities: withShare(cities),
    trends: { states: stateTrend, cities: cityTrend },
    movers: { rising, falling },
  };
}
