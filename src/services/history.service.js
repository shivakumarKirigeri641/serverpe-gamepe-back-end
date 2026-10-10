/**
 * One player's whole life on the platform, from their first game to their last.
 *
 * The end-of-game report answers "how did I just do?". This answers "how am I
 * doing?" — which is a different question and needs a different shape: every
 * game in order, trends over time, and the handful of numbers that only mean
 * something once you have a few games to compare against.
 *
 * ── What "accuracy" means here ─────────────────────────────────────────────
 *
 * Every number called is one decision for every seated player: is it on my
 * ticket, yes or no. draw_answers records what they said and whether it was
 * right, so accuracy is simply correct decisions over decisions offered. Three
 * distinct things can go wrong, and they are counted separately because they
 * are different mistakes with different fixes:
 *
 *   missed       — it WAS on their ticket and they said no, or said nothing.
 *                  The costly one: an unmarked number cannot win a prize.
 *   wrong tap    — it was NOT on their ticket and they said yes. Harmless to
 *                  their score (claims are validated against the draw record,
 *                  never against marks) but a good signal they are rushing.
 *   no response  — they never answered at all. Distraction, or a dropped
 *                  connection; counted apart from a considered wrong answer.
 *
 * ── Why so much of this is computed in SQL ─────────────────────────────────
 *
 * A player with two hundred games has tens of thousands of draw_answers rows.
 * Pulling those into Node to count them would work fine for the first player
 * and badly for the hundredth, so the aggregation stays in the database and
 * only the summaries travel.
 */
import { query } from '../db/pool.js';
import { config } from '../config/env.js';
import { displayNameFor } from './player.service.js';

const TZ = 'Asia/Kolkata';

/** Percentage, guarded against a zero denominator. */
const pct = (n, d) => (Number(d) ? Math.round((Number(n) / Number(d)) * 100) : 0);

/**
 * Change between two numbers, as something a person can read.
 *
 * Deliberately not a bare percentage: 0 -> 3 is not "+300%", it is "new", and
 * saying so is more useful than an impressive-looking number that means
 * nothing.
 */
function movement(now, before) {
  const n = Number(now) || 0;
  const b = Number(before) || 0;
  if (b === 0 && n === 0) return { pct: null, label: '—', direction: 'flat' };
  if (b === 0) return { pct: null, label: 'new', direction: 'up' };
  const change = Math.round(((n - b) / b) * 100);
  if (change === 0) return { pct: 0, label: 'no change', direction: 'flat' };
  return {
    pct: change,
    label: `${change > 0 ? '+' : ''}${change}%`,
    direction: change > 0 ? 'up' : 'down',
  };
}

/** Headline totals: games, roles, prizes, span. */
async function totals(playerId) {
  const { rows } = await query(`
    SELECT
      count(*)::int                                                    AS games,
      count(*) FILTER (WHERE gp.is_host)::int                          AS as_host,
      count(*) FILTER (WHERE NOT gp.is_host)::int                      AS as_player,
      count(*) FILTER (WHERE g.status = 'finished')::int               AS finished,
      count(*) FILTER (WHERE g.status = 'abandoned')::int              AS abandoned,
      count(*) FILTER (WHERE gp.left_at IS NOT NULL)::int              AS left_early,
      min(g.created_at)                                                AS first_game_at,
      max(g.created_at)                                                AS last_game_at,
      count(DISTINCT (g.created_at AT TIME ZONE $2)::date)::int         AS days_played
    FROM game_players gp
    JOIN games g ON g.id = gp.game_id
   WHERE gp.player_id = $1
  `, [playerId, TZ]);
  return rows[0];
}

/** Prizes won, by kind. */
async function prizes(playerId) {
  const { rows } = await query(`
    SELECT claim_type, count(*)::int AS won
      FROM claims
     WHERE player_id = $1 AND status = 'awarded'
     GROUP BY claim_type
  `, [playerId]);

  const byKind = Object.fromEntries(rows.map((r) => [r.claim_type, r.won]));
  const total = rows.reduce((sum, r) => sum + r.won, 0);

  // Rejected claims are worth showing: a player who claims early and gets
  // refused is making a specific, fixable mistake.
  const { rows: rej } = await query(
    `SELECT count(*)::int AS n FROM claims WHERE player_id = $1 AND status <> 'awarded'`,
    [playerId],
  );

  return { byKind, total, rejected: rej[0].n };
}

/**
 * Lifetime marking accuracy, split by what actually went wrong.
 *
 * `was_correct` is written at answer time against the ticket, so this needs no
 * ticket parsing here.
 */
async function accuracy(playerId) {
  const { rows } = await query(`
    SELECT
      count(*)::int                                                        AS decisions,
      count(*) FILTER (WHERE a.answer <> 'no_response')::int               AS answered,
      count(*) FILTER (WHERE a.was_correct)::int                           AS correct,
      count(*) FILTER (WHERE a.answer = 'no'  AND a.was_correct = false)::int  AS missed,
      count(*) FILTER (WHERE a.answer = 'yes' AND a.was_correct = false)::int  AS wrong_taps,
      count(*) FILTER (WHERE a.answer = 'no_response')::int                AS no_response,
      round(avg(EXTRACT(EPOCH FROM (a.answered_at - d.drawn_at)))
            FILTER (WHERE a.answered_at IS NOT NULL), 1)                   AS avg_seconds
    FROM draw_answers a
    JOIN draws d ON d.game_id = a.game_id AND d.seq = a.seq
   WHERE a.player_id = $1
  `, [playerId]);

  const r = rows[0];
  return {
    ...r,
    // Over what they answered. Dividing by every number offered - which is
    // what this did - scored a player whose board dropped out as inaccurate
    // rather than as absent, and the same figure feeds the improvement
    // section below, so a bad signal looked like a decline in skill.
    accuracyPct: pct(r.correct, r.answered),
    responsePct: pct(r.answered, r.decisions),
  };
}

/**
 * Every game, newest first — the scorecard.
 *
 * One row per game with that game's own accuracy, so the table doubles as the
 * trend line: the improvement section below is derived from exactly these
 * numbers rather than a second, differently-shaped query that could disagree.
 */
async function games(playerId, limit = 500) {
  const { rows } = await query(`
    SELECT g.id, g.code, g.status, g.ended_reason,
           g.created_at, g.started_at, g.ended_at,
           g.cursor                                                  AS numbers_called,
           g.expected_players,
           gp.is_host, gp.joined_at, gp.left_at,
           (SELECT count(*)::int FROM game_players x
             WHERE x.game_id = g.id)                                 AS seats,
           (SELECT count(*)::int FROM claims c
             WHERE c.game_id = g.id AND c.player_id = $1
               AND c.status = 'awarded')                             AS prizes_won,
           (SELECT string_agg(c.claim_type, ', ' ORDER BY c.created_at)
              FROM claims c
             WHERE c.game_id = g.id AND c.player_id = $1
               AND c.status = 'awarded')                             AS prize_list,
           (SELECT count(*)::int FROM draw_answers a
             WHERE a.game_id = g.id AND a.player_id = $1)            AS decisions,
           (SELECT count(*)::int FROM draw_answers a
             WHERE a.game_id = g.id AND a.player_id = $1
               AND a.answer <> 'no_response')                           AS answered,
           (SELECT count(*)::int FROM draw_answers a
             WHERE a.game_id = g.id AND a.player_id = $1
               AND a.was_correct)                                    AS correct,
           (SELECT count(*)::int FROM draw_answers a
             WHERE a.game_id = g.id AND a.player_id = $1
               AND a.answer = 'no' AND a.was_correct = false)        AS missed,
           (SELECT count(*)::int FROM draw_answers a
             WHERE a.game_id = g.id AND a.player_id = $1
               AND a.answer = 'yes' AND a.was_correct = false)       AS wrong_taps,
           (SELECT count(*)::int FROM draw_answers a
             WHERE a.game_id = g.id AND a.player_id = $1
               AND a.answer = 'no_response')                         AS no_response,
           hp.display_name                                           AS host_name,
           hp.wa_id                                                  AS host_wa_id
      FROM game_players gp
      JOIN games g   ON g.id = gp.game_id
      JOIN players hp ON hp.id = g.host_player_id
     WHERE gp.player_id = $1
     ORDER BY g.created_at DESC
     LIMIT $2
  `, [playerId, limit]);

  return rows.map((r) => ({
    ...r,
    accuracyPct: pct(r.correct, r.answered),
    prizeList: r.prize_list ? r.prize_list.split(', ') : [],
  }));
}

/**
 * Who they have played with, and how they compare.
 *
 * The leaderboard is over shared games only. Ranking a player against people
 * they have never sat at a table with would be a different product; this
 * answers "how do I do against the people I actually play with".
 */
async function leaderboard(playerId) {
  const { rows } = await query(`
    WITH mine AS (
      SELECT game_id FROM game_players WHERE player_id = $1
    )
    SELECT p.id,
           p.display_name,
           p.wa_id,
           count(DISTINCT gp.game_id)::int                             AS games_together,
           count(*) FILTER (WHERE a.was_correct)::int                  AS correct,
           count(*) FILTER (WHERE a.answer <> 'no_response')::int      AS answered,
           count(a.*)::int                                             AS decisions,
           (SELECT count(*)::int FROM claims c
             WHERE c.player_id = p.id AND c.status = 'awarded'
               AND c.game_id IN (SELECT game_id FROM mine))            AS prizes
      FROM game_players gp
      JOIN mine m       ON m.game_id = gp.game_id
      JOIN players p    ON p.id = gp.player_id
      LEFT JOIN draw_answers a
             ON a.game_id = gp.game_id AND a.player_id = gp.player_id
     GROUP BY p.id, p.display_name, p.wa_id
     HAVING count(DISTINCT gp.game_id) > 0
     ORDER BY prizes DESC, correct DESC
     LIMIT 25
  `, [playerId]);

  return rows.map((r) => ({
    ...r,
    isYou: r.id === playerId,
    accuracyPct: pct(r.correct, r.answered),
  }));
}

/**
 * Games per calendar day, for the activity chart.
 *
 * Prizes are aggregated in their own CTE and joined, rather than counted in a
 * correlated subquery: the subquery would have to reference the ungrouped
 * game row it sits beside, which Postgres rejects outright.
 */
async function byDay(playerId) {
  const { rows } = await query(`
    WITH played AS (
      SELECT (g.created_at AT TIME ZONE $2)::date       AS day,
             count(*)::int                              AS games,
             count(*) FILTER (WHERE gp.is_host)::int    AS hosted
        FROM game_players gp
        JOIN games g ON g.id = gp.game_id
       WHERE gp.player_id = $1
       GROUP BY 1
    ),
    won AS (
      SELECT (c.created_at AT TIME ZONE $2)::date AS day,
             count(*)::int                        AS prizes
        FROM claims c
       WHERE c.player_id = $1 AND c.status = 'awarded'
       GROUP BY 1
    )
    SELECT played.day::text        AS day,
           played.games,
           played.hosted,
           COALESCE(won.prizes, 0) AS prizes
      FROM played
      LEFT JOIN won ON won.day = played.day
     ORDER BY played.day
  `, [playerId, TZ]);
  return rows;
}

/** What time of day they play. Purely a nice thing to know about yourself. */
async function byHour(playerId) {
  const { rows } = await query(`
    SELECT EXTRACT(HOUR FROM (g.created_at AT TIME ZONE $2))::int AS hour,
           count(*)::int                                          AS games
      FROM game_players gp
      JOIN games g ON g.id = gp.game_id
     WHERE gp.player_id = $1
     GROUP BY 1 ORDER BY 1
  `, [playerId, TZ]);

  const full = Array.from({ length: 24 }, (_, h) => ({ hour: h, games: 0 }));
  for (const r of rows) full[r.hour].games = r.games;
  return full;
}

/**
 * Are they getting better?
 *
 * Compares the most recent third of their games with the oldest third, and
 * says nothing at all under six games. Below that the "trend" is noise, and a
 * report that tells a three-game player their accuracy is down 40% because of
 * one bad afternoon is worse than one that stays quiet.
 */
function improvement(gameList) {
  const played = gameList.filter((g) => g.decisions > 0);
  if (played.length < 6) {
    return { enough: false, needed: 6, have: played.length };
  }

  // gameList is newest-first.
  const size = Math.max(2, Math.floor(played.length / 3));
  const recent = played.slice(0, size);
  const early = played.slice(-size);

  const avg = (rows, key) =>
    rows.reduce((sum, r) => sum + Number(r[key] || 0), 0) / (rows.length || 1);

  const recentAcc = pct(avg(recent, 'correct'), avg(recent, 'answered'));
  const earlyAcc = pct(avg(early, 'correct'), avg(early, 'answered'));

  return {
    enough: true,
    window: size,
    accuracy: { now: recentAcc, before: earlyAcc, ...movement(recentAcc, earlyAcc) },
    missed: {
      now: Number(avg(recent, 'missed').toFixed(1)),
      before: Number(avg(early, 'missed').toFixed(1)),
      // Fewer misses is an improvement, so the direction is inverted for the
      // reader: "down 30%" here is good news and should not read as a warning.
      ...movement(avg(recent, 'missed'), avg(early, 'missed')),
      lowerIsBetter: true,
    },
    wrongTaps: {
      now: Number(avg(recent, 'wrong_taps').toFixed(1)),
      before: Number(avg(early, 'wrong_taps').toFixed(1)),
      ...movement(avg(recent, 'wrong_taps'), avg(early, 'wrong_taps')),
      lowerIsBetter: true,
    },
  };
}

/**
 * The plain-language read on what to work on.
 *
 * Ordered by what would actually gain them the most, and capped: a list of
 * nine things to improve is a list nobody acts on.
 */
function advice({ acc, tot, pz, imp }) {
  const out = [];

  if (acc.decisions === 0) {
    out.push('You have not marked a number yet — open your board next game and tap along.');
    return out;
  }

  if (acc.no_response > acc.decisions * 0.25) {
    out.push(
      `You did not answer ${pct(acc.no_response, acc.decisions)}% of the numbers called. ` +
      `Keeping the board open during the game is the single biggest thing you can change.`,
    );
  }
  if (acc.missed > 0 && pct(acc.missed, acc.answered) >= 10) {
    out.push(
      `${acc.missed} number${acc.missed === 1 ? ' was' : 's were'} on your ticket and went ` +
      `unmarked. Those are the ones that cost prizes.`,
    );
  }
  if (acc.wrong_taps > acc.correct * 0.15) {
    out.push(
      `${acc.wrong_taps} taps were for numbers not on your ticket — a sign of rushing. ` +
      `They cost you nothing, but the time spent could go on finding the real one.`,
    );
  }
  if (pz.rejected > 0) {
    out.push(
      `${pz.rejected} claim${pz.rejected === 1 ? '' : 's'} were turned down because the pattern ` +
      `was not complete yet. Wait for the prize to light up before claiming.`,
    );
  }
  if (Number(acc.avg_seconds) > 6) {
    out.push(
      `You take about ${acc.avg_seconds}s to answer. There is no prize for speed, but a faster ` +
      `scan leaves more time to spot the number before the next one.`,
    );
  }
  if (tot.left_early > 0) {
    out.push(
      `You left ${tot.left_early} game${tot.left_early === 1 ? '' : 's'} before the end. ` +
      `Leaving can end the game for everyone if it drops below two players.`,
    );
  }
  if (imp.enough && imp.accuracy.direction === 'up') {
    out.push(
      `Your accuracy is up from ${imp.accuracy.before}% to ${imp.accuracy.now}% across your ` +
      `recent games — whatever you changed, keep doing it.`,
    );
  }

  if (!out.length) {
    out.push('Nothing stands out to fix — your marking is clean. Keep playing.');
  }
  return out.slice(0, 5);
}

/** Everything, for one player. */
export async function playerHistory(playerId) {
  const { rows: people } = await query('SELECT * FROM players WHERE id = $1', [playerId]);
  const player = people[0];
  if (!player) return null;

  const [tot, pz, acc, gameList, board, days, hours] = await Promise.all([
    totals(playerId),
    prizes(playerId),
    accuracy(playerId),
    games(playerId),
    leaderboard(playerId),
    byDay(playerId),
    byHour(playerId),
  ]);

  const imp = improvement(gameList);

  return {
    brand: config.brandName,
    generatedAt: new Date().toISOString(),
    player: {
      name: displayNameFor(player),
      waId: player.wa_id,
      joinedAt: player.created_at,
      lastSeenAt: player.last_seen_at,
      city: player.last_city,
      region: player.last_region,
      device: [player.last_device_type, player.last_os, player.last_browser]
        .filter(Boolean).join(' · ') || null,
    },
    totals: tot,
    prizes: pz,
    accuracy: acc,
    improvement: imp,
    advice: advice({ acc, tot: tot, pz, imp }),
    games: gameList,
    leaderboard: board,
    byDay: days,
    byHour: hours,
  };
}
