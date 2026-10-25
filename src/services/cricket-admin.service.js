/**
 * What an operator needs to see about Hand Cricket.
 *
 * Its own file and its own tab in the panel, like Tap Bakra: a cricket match
 * is two sides for a few minutes, nothing like a Tambola room, and mixing the
 * numbers would describe neither.
 *
 * Everything here is read-only.
 */
import { query } from '../db/pool.js';

const num = (v) => (v === null || v === undefined ? null : Number(v));
const IST_TODAY = `(now() AT TIME ZONE 'Asia/Kolkata')::date`;

/** Who the two sides were, by name, for any list of matches. */
const SIDES = `
  coalesce(h.display_name, 'Player ' || right(h.wa_id, 4)) AS host_name,
  CASE WHEN m.mode = 'bot' THEN 'Bot (' || m.bot_level || ')'
       ELSE coalesce(g.display_name, CASE WHEN g.id IS NULL THEN NULL ELSE 'Player ' || right(g.wa_id, 4) END) END AS guest_name`;

/**
 * The headline numbers, over today, seven days and thirty. Completion matters
 * most for the friend mode: a friend who never turns up is the failure this
 * game can actually have.
 */
export async function overview() {
  const { rows } = await query(`
    SELECT
      count(*) FILTER (WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${IST_TODAY})::int AS today,
      count(*) FILTER (WHERE created_at > now() - interval '7 days')::int  AS d7,
      count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS d30,
      count(*)::int                                                        AS all_time,
      count(*) FILTER (WHERE mode = 'bot')::int                            AS bot,
      count(*) FILTER (WHERE mode = 'friend')::int                         AS friend,
      count(*) FILTER (WHERE status = 'finished')::int                     AS finished,
      count(*) FILTER (WHERE status = 'abandoned')::int                    AS abandoned,
      count(*) FILTER (WHERE mode = 'friend' AND guest_player_id IS NULL)::int AS friend_never_joined,
      count(*) FILTER (WHERE status IN ('toss','choose','playing') AND last_move_at > now() - interval '5 minutes')::int AS live,
      round(avg(runs1) FILTER (WHERE status = 'finished'), 1)              AS avg_first_innings,
      max(greatest(runs1, runs2))                                          AS best_innings,
      count(*) FILTER (WHERE status = 'finished' AND mode = 'bot' AND winner = 1)::int AS bot_player_wins,
      count(*) FILTER (WHERE status = 'finished' AND mode = 'bot')::int    AS bot_finished
    FROM cricket_matches`);
  const { rows: p } = await query(`
    SELECT count(DISTINCT pid) FILTER (WHERE at > now() - interval '7 days')::int AS players_7d,
           count(DISTINCT pid)::int AS players_all
      FROM (SELECT host_player_id AS pid, created_at AS at FROM cricket_matches
            UNION ALL SELECT guest_player_id, created_at FROM cricket_matches WHERE guest_player_id IS NOT NULL) x`);
  const o = rows[0];
  const done = o.finished + o.abandoned;
  return {
    today: o.today, d7: o.d7, d30: o.d30, all: o.all_time,
    bot: o.bot, friend: o.friend, live: o.live,
    finished: o.finished, abandoned: o.abandoned, friendNeverJoined: o.friend_never_joined,
    completionPct: done ? Math.round((o.finished / done) * 100) : null,
    players7d: p[0].players_7d, playersAll: p[0].players_all,
    avgFirstInnings: num(o.avg_first_innings), bestInnings: num(o.best_innings),
    // How often people beat the bot - if it is near 0% or 100%, a level is mis-tuned.
    playerWinPctVsBot: o.bot_finished ? Math.round((o.bot_player_wins / o.bot_finished) * 100) : null,
  };
}

/** Matches per day, split by mode. */
export async function daily(days = 30) {
  const { rows } = await query(`
    SELECT to_char(d, 'YYYY-MM-DD') AS day,
           count(m.id) FILTER (WHERE m.mode = 'bot')::int    AS bot,
           count(m.id) FILTER (WHERE m.mode = 'friend')::int AS friend,
           count(m.id)::int                                  AS matches
      FROM generate_series(${IST_TODAY} - ($1::int - 1), ${IST_TODAY}, interval '1 day') d
      LEFT JOIN cricket_matches m ON (m.created_at AT TIME ZONE 'Asia/Kolkata')::date = d::date
     GROUP BY d ORDER BY d`, [days]);
  return rows;
}

/** The latest matches, newest first. */
export async function recentMatches(limit = 50) {
  const { rows } = await query(`
    SELECT m.id, m.mode, m.bot_level, m.code, m.status, m.innings, m.bat_first, m.winner, m.result,
           m.runs1, m.wkts1, m.balls1, m.runs2, m.wkts2, m.balls2, m.created_at, m.finished_at, m.last_move_at,
           ${SIDES}
      FROM cricket_matches m
      JOIN players h ON h.id = m.host_player_id
      LEFT JOIN players g ON g.id = m.guest_player_id
     ORDER BY m.id DESC LIMIT $1`, [limit]);
  return rows.map((r) => ({
    ...r,
    id: Number(r.id),
    result: r.result && r.result.startsWith('toss:') ? null : r.result,
  }));
}

/** One match, ball by ball. */
export async function matchDetail(id) {
  const { rows } = await query(`
    SELECT m.*, ${SIDES}
      FROM cricket_matches m
      JOIN players h ON h.id = m.host_player_id
      LEFT JOIN players g ON g.id = m.guest_player_id
     WHERE m.id = $1`, [id]);
  if (!rows[0]) return null;
  const { rows: balls } = await query(
    'SELECT innings, ball_no, batter, bat_pick, bowl_pick, runs, is_out, created_at FROM cricket_balls WHERE match_id = $1 ORDER BY innings, ball_no',
    [id]);
  const m = rows[0];
  return {
    ...m,
    id: Number(m.id),
    // The waiting picks are not the operator's business either, mid-match.
    pick1: undefined, pick2: undefined,
    result: m.result && m.result.startsWith('toss:') ? null : m.result,
    balls,
  };
}

/** Matches in progress in the last few minutes - "playing right now". */
export async function live() {
  const { rows } = await query(`
    SELECT m.id, m.mode, m.bot_level, m.status, m.innings, m.runs1, m.wkts1, m.balls1, m.runs2, m.wkts2, m.balls2,
           extract(epoch FROM now() - m.last_move_at)::int AS idle_seconds, ${SIDES}
      FROM cricket_matches m
      JOIN players h ON h.id = m.host_player_id
      LEFT JOIN players g ON g.id = m.guest_player_id
     WHERE m.status IN ('waiting','toss','choose','playing') AND m.last_move_at > now() - interval '30 minutes'
     ORDER BY m.last_move_at DESC LIMIT 50`);
  return rows.map((r) => ({ ...r, id: Number(r.id), active: r.idle_seconds < 120 }));
}

/** The best players: wins first, then the best single innings. */
export async function leaderboard(limit = 25) {
  const { rows } = await query(`
    WITH sides AS (
      SELECT m.host_player_id AS pid, 1 AS side, m.* FROM cricket_matches m WHERE m.status = 'finished'
      UNION ALL
      SELECT m.guest_player_id, 2, m.* FROM cricket_matches m WHERE m.status = 'finished' AND m.guest_player_id IS NOT NULL
    )
    SELECT s.pid AS player_id,
           coalesce(p.display_name, 'Player ' || right(p.wa_id, 4)) AS player,
           count(*)::int AS played,
           count(*) FILTER (WHERE s.winner = s.side)::int AS won,
           max(CASE WHEN s.bat_first = s.side THEN s.runs1 ELSE s.runs2 END)::int AS best,
           round(avg(CASE WHEN s.bat_first = s.side THEN s.runs1 ELSE s.runs2 END), 1) AS average
      FROM sides s JOIN players p ON p.id = s.pid
     GROUP BY s.pid, p.display_name, p.wa_id
     ORDER BY won DESC, best DESC NULLS LAST
     LIMIT $1`, [limit]);
  return rows.map((r) => ({ ...r, player_id: Number(r.player_id), average: num(r.average) }));
}
