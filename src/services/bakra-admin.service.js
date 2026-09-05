/**
 * What an operator needs to see about Tap Bakra.
 *
 * Kept apart from admin-data.service.js on purpose. That file is entirely
 * about Tambola - games, tickets, draws, claims - and mixing a second game's
 * queries into it would leave nobody able to tell which numbers belong to
 * which game. The panel has a master tab per game for the same reason.
 *
 * Everything here is read-only.
 */
import { query } from '../db/pool.js';
import { questionById } from '../games/fatafat/questions.js';

const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * The headline numbers, over three windows.
 *
 * Today, seven days and thirty, because a single total cannot tell growth from
 * a good Tuesday - and the first question an operator asks a dashboard is
 * always "is this better or worse than it was".
 */
export async function overview() {
  const { rows } = await query(`
    WITH r AS (
      SELECT id, player_id, score, status, created_at, finished_at,
             (created_at AT TIME ZONE 'Asia/Kolkata')::date AS day
        FROM fatafat_rounds
    ),
    a AS (
      SELECT fa.round_id, fa.was_correct, fa.taken_ms, fa.mode
        FROM fatafat_answers fa
    )
    SELECT
      count(*) FILTER (WHERE r.day = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int  AS rounds_today,
      count(*) FILTER (WHERE r.created_at > now() - interval '7 days')::int           AS rounds_7d,
      count(*) FILTER (WHERE r.created_at > now() - interval '30 days')::int          AS rounds_30d,
      count(*)::int                                                                   AS rounds_all,
      count(*) FILTER (WHERE r.status = 'open')::int                                  AS rounds_open,
      count(DISTINCT r.player_id) FILTER (WHERE r.created_at > now() - interval '7 days')::int AS players_7d,
      count(DISTINCT r.player_id)::int                                                AS players_all,
      round(avg(r.score) FILTER (WHERE r.status = 'finished'))                        AS avg_score,
      max(r.score)                                                                    AS best_score
    FROM r
  `);

  const { rows: acc } = await query(`
    SELECT count(*)::int                                     AS answers,
           count(*) FILTER (WHERE was_correct)::int           AS correct,
           round(avg(taken_ms) FILTER (WHERE was_correct AND mode <> 'hold')) AS avg_ms
      FROM fatafat_answers
  `);

  // A round started and never finished. Worth watching: a rise here is people
  // walking out mid-game, which no score average would ever show.
  const { rows: drop } = await query(`
    SELECT count(*) FILTER (WHERE status = 'open' AND created_at < now() - interval '1 hour')::int AS abandoned,
           count(*) FILTER (WHERE status = 'finished')::int AS finished
      FROM fatafat_rounds
  `);

  const o = rows[0], c = acc[0], d = drop[0];
  const completion = d.finished + d.abandoned
    ? Math.round((d.finished / (d.finished + d.abandoned)) * 100) : null;

  return {
    roundsToday: o.rounds_today, rounds7d: o.rounds_7d, rounds30d: o.rounds_30d,
    roundsAll: o.rounds_all, roundsOpen: o.rounds_open,
    players7d: o.players_7d, playersAll: o.players_all,
    avgScore: num(o.avg_score),
    // numeric(8,2) out of Postgres - a score of 225.68 on a dashboard reads as
    // a bug, not as precision.
    bestScore: o.best_score === null ? null : Math.round(Number(o.best_score)),
    answers: c.answers, correct: c.correct,
    accuracyPct: c.answers ? Math.round((c.correct / c.answers) * 100) : null,
    avgMs: num(c.avg_ms),
    abandoned: d.abandoned, finished: d.finished, completionPct: completion,
  };
}

/** Rounds per day, for the chart. */
export async function daily(days = 30) {
  const { rows } = await query(`
    SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
           count(*)::int                                   AS rounds,
           count(DISTINCT player_id)::int                  AS players,
           round(avg(score) FILTER (WHERE status = 'finished')) AS avg_score
      FROM fatafat_rounds
     WHERE created_at > now() - ($1 || ' days')::interval
     GROUP BY 1 ORDER BY 1
  `, [String(days)]);
  return rows.map((r) => ({
    day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day),
    rounds: r.rounds, players: r.players, avgScore: num(r.avg_score),
  }));
}

/** The most recent rounds, with who played them. */
export async function recentRounds(limit = 50) {
  const { rows } = await query(`
    SELECT r.id, r.player_id, r.score, r.status, r.lang, r.question_count,
           r.created_at, r.finished_at,
           COALESCE(NULLIF(p.display_name, ''), p.wa_id)      AS player,
           p.wa_id,
           p.last_city, p.last_region,
           count(a.*)::int                                     AS answered,
           count(a.*) FILTER (WHERE a.was_correct)::int        AS correct,
           round(avg(a.taken_ms) FILTER (WHERE a.was_correct AND a.mode <> 'hold')) AS avg_ms
      FROM fatafat_rounds r
      JOIN players p ON p.id = r.player_id
      LEFT JOIN fatafat_answers a ON a.round_id = r.id
     GROUP BY r.id, p.display_name, p.wa_id, p.last_city, p.last_region
     ORDER BY r.created_at DESC
     LIMIT $1
  `, [limit]);

  return rows.map((r) => ({
    id: Number(r.id), playerId: Number(r.player_id), player: r.player, waId: r.wa_id,
    city: r.last_city, region: r.last_region,
    score: Math.round(Number(r.score)), status: r.status, lang: r.lang,
    answered: r.answered, correct: r.correct, avgMs: num(r.avg_ms),
    createdAt: r.created_at, finishedAt: r.finished_at,
  }));
}

/** One round, question by question - the audit trail for a disputed score. */
export async function roundDetail(roundId) {
  const { rows: head } = await query(`
    SELECT r.*, COALESCE(NULLIF(p.display_name, ''), p.wa_id) AS player, p.wa_id
      FROM fatafat_rounds r JOIN players p ON p.id = r.player_id
     WHERE r.id = $1
  `, [roundId]);
  if (!head[0]) return null;

  const { rows: answers } = await query(
    'SELECT * FROM fatafat_answers WHERE round_id = $1 ORDER BY seq', [roundId],
  );

  return {
    round: {
      id: Number(head[0].id), player: head[0].player, waId: head[0].wa_id,
      playerId: Number(head[0].player_id),
      score: Math.round(Number(head[0].score)), status: head[0].status,
      lang: head[0].lang, seed: String(head[0].seed),
      createdAt: head[0].created_at, finishedAt: head[0].finished_at,
    },
    answers: answers.map((a) => {
      const q = questionById(a.question_id);
      return {
        seq: a.seq, questionId: a.question_id, mode: a.mode, difficulty: a.difficulty,
        instruction: q ? q.instruction : '(question not in this build of the bank)',
        options: q ? q.options : [],
        correctPositions: q ? q.correctPositions : [],
        tapped: a.tapped === '' ? [] : a.tapped.split(',').map(Number),
        wasCorrect: a.was_correct,
        takenMs: num(a.taken_ms), serverMs: num(a.server_ms),
        twisted: a.twisted, points: Number(a.points), trap: q ? q.trap : '',
      };
    }),
  };
}

/**
 * Which questions are actually beating people.
 *
 * The point of this screen: a question everyone gets wrong is either a very
 * good trap or a broken row, and only reading the question itself tells you
 * which. So the instruction and options come along with the number.
 */
export async function questionAnalytics({ minAsked = 3, limit = 25 } = {}) {
  const { rows: byMode } = await query(`
    SELECT mode,
           count(*)::int                              AS asked,
           count(*) FILTER (WHERE was_correct)::int   AS correct,
           round(avg(taken_ms) FILTER (WHERE was_correct AND mode <> 'hold')) AS avg_ms
      FROM fatafat_answers GROUP BY mode ORDER BY count(*) DESC
  `);

  const { rows: byDifficulty } = await query(`
    SELECT difficulty,
           count(*)::int                              AS asked,
           count(*) FILTER (WHERE was_correct)::int   AS correct,
           round(avg(taken_ms) FILTER (WHERE was_correct AND mode <> 'hold')) AS avg_ms
      FROM fatafat_answers GROUP BY difficulty ORDER BY difficulty
  `);

  const { rows: hardest } = await query(`
    SELECT question_id, mode, difficulty,
           count(*)::int                              AS asked,
           count(*) FILTER (WHERE was_correct)::int   AS correct
      FROM fatafat_answers
     GROUP BY question_id, mode, difficulty
    HAVING count(*) >= $1
     ORDER BY (count(*) FILTER (WHERE was_correct))::numeric / count(*) ASC, count(*) DESC
     LIMIT $2
  `, [minAsked, limit]);

  const withText = hardest.map((h) => {
    const q = questionById(h.question_id);
    return {
      questionId: h.question_id, mode: h.mode, difficulty: h.difficulty,
      asked: h.asked, correct: h.correct,
      accuracyPct: Math.round((h.correct / h.asked) * 100),
      instruction: q ? q.instruction : '(not in this build)',
      options: q ? q.options : [],
      answer: q ? (q.correctPositions.length ? q.correctPositions.map((p) => q.options[p - 1]).join(' + ') : 'nothing') : '',
      trap: q ? q.trap : '',
    };
  });

  // How the traps are performing, which is the closest thing this game has to
  // a content quality score.
  const { rows: traps } = await query(`
    SELECT a.question_id, a.was_correct FROM fatafat_answers a
  `);
  const trapStats = {};
  for (const t of traps) {
    const q = questionById(t.question_id);
    const key = q && q.trap ? q.trap : 'none';
    trapStats[key] ??= { asked: 0, correct: 0 };
    trapStats[key].asked++;
    if (t.was_correct) trapStats[key].correct++;
  }

  return {
    byMode: byMode.map((m) => ({
      mode: m.mode, asked: m.asked, correct: m.correct,
      accuracyPct: m.asked ? Math.round((m.correct / m.asked) * 100) : null,
      avgMs: num(m.avg_ms),
    })),
    byDifficulty: byDifficulty.map((d) => ({
      difficulty: d.difficulty, asked: d.asked, correct: d.correct,
      accuracyPct: d.asked ? Math.round((d.correct / d.asked) * 100) : null,
      avgMs: num(d.avg_ms),
    })),
    hardest: withText,
    traps: Object.entries(trapStats).map(([trap, v]) => ({
      trap, asked: v.asked, correct: v.correct,
      accuracyPct: v.asked ? Math.round((v.correct / v.asked) * 100) : null,
    })).sort((a, b) => b.asked - a.asked),
  };
}

/** The best players, for the operator's own leaderboard view. */
export async function leaderboard(limit = 25) {
  const { rows } = await query(`
    SELECT r.player_id,
           COALESCE(NULLIF(p.display_name, ''), p.wa_id) AS player,
           p.wa_id, p.last_city,
           -- DISTINCT because the answers join multiplies each round by its
           -- ten answers. Without it a player with nine rounds reads as ninety.
           count(DISTINCT r.id)::int                       AS rounds,
           max(r.score)                                   AS best,
           round(avg(r.score))                            AS average,
           count(a.*) FILTER (WHERE a.was_correct)::int   AS correct,
           count(a.*)::int                                AS answered,
           round(avg(a.taken_ms) FILTER (WHERE a.was_correct AND a.mode <> 'hold')) AS avg_ms
      FROM fatafat_rounds r
      JOIN players p ON p.id = r.player_id
      LEFT JOIN fatafat_answers a ON a.round_id = r.id
     WHERE r.status = 'finished'
     GROUP BY r.player_id, p.display_name, p.wa_id, p.last_city
     ORDER BY max(r.score) DESC
     LIMIT $1
  `, [limit]);

  return rows.map((r) => ({
    playerId: Number(r.player_id), player: r.player, waId: r.wa_id, city: r.last_city,
    rounds: r.rounds, best: Math.round(Number(r.best)), average: num(r.average),
    accuracyPct: r.answered ? Math.round((r.correct / r.answered) * 100) : null,
    avgMs: num(r.avg_ms),
  }));
}

/**
 * Rounds in flight, for live monitoring.
 *
 * "Live" here means started and not yet finished, with the last answer inside
 * a couple of minutes - a round left open on a closed tab is not somebody
 * playing, and showing it as live would make the screen lie.
 */
export async function live() {
  const { rows } = await query(`
    SELECT r.id, r.player_id, r.question_count, r.lang, r.created_at, r.current_seq,
           COALESCE(NULLIF(p.display_name, ''), p.wa_id) AS player,
           p.last_city, p.last_region,
           max(a.answered_at)                             AS last_answer_at,
           count(a.*)::int                                AS answered,
           count(a.*) FILTER (WHERE a.was_correct)::int   AS correct
      FROM fatafat_rounds r
      JOIN players p ON p.id = r.player_id
      LEFT JOIN fatafat_answers a ON a.round_id = r.id
     WHERE r.status = 'open' AND r.created_at > now() - interval '30 minutes'
     GROUP BY r.id, p.display_name, p.wa_id, p.last_city, p.last_region
     ORDER BY r.created_at DESC
     LIMIT 50
  `);

  const now = Date.now();
  return rows.map((r) => {
    const last = r.last_answer_at ? new Date(r.last_answer_at).getTime() : new Date(r.created_at).getTime();
    return {
      id: Number(r.id), playerId: Number(r.player_id), player: r.player,
      city: r.last_city, region: r.last_region, lang: r.lang,
      seq: r.current_seq, of: r.question_count,
      answered: r.answered, correct: r.correct,
      idleSeconds: Math.round((now - last) / 1000),
      // Still tapping, or just a tab left open?
      active: now - last < 120000,
    };
  });
}
