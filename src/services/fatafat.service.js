/**
 * Fatafat: rounds, answers, scoring and the report.
 *
 * ── Where the truth lives ─────────────────────────────────────────────────
 *
 * The page is told what to show and nothing else. It never receives which
 * option is correct, and it never decides whether an answer was right - both
 * happen here. A page that scores itself is a page that can score itself
 * perfectly, and this game's whole value is a number a player believes.
 *
 * So the flow is: the server hands out one question and remembers when it did;
 * the page reports which slots were tapped and how long the player took; the
 * server decides. The player's stopwatch is trusted for the millisecond
 * figure - the server's own elapsed time includes the round trip, and scoring
 * on that would rank mobile networks rather than reflexes - but both are
 * stored, so a claim faster than physics can be seen after the fact.
 */
import { query } from '../db/pool.js';
import { log } from '../utils/logger.js';
import { buildRound, isNoGo, questionById, bankSize } from '../games/fatafat/questions.js';
import { localise } from '../games/fatafat/hindi.js';

/** Nobody reads three options and decides in under this. */
export const FLOOR_MS = 150;
export const QUESTIONS = 10;
export const TIME_LIMIT_MS = 5000;

/** The weights. Named, so changing one is a decision rather than an edit. */
export const SCORING = {
  streakStep: 0.05,
  streakCap: 2.0,
};

const streakMult = (run) => Math.min(1 + run * SCORING.streakStep, SCORING.streakCap);

/**
 * Speed is scored on a curve, not a straight line.
 *
 * Linear decay lets a fast, sloppy player beat a careful, near-perfect one by
 * a distance; the square root closes that gap to almost nothing while still
 * rewarding speed. It also compresses the top end, so thirty milliseconds
 * stops deciding a leaderboard.
 */
const speedFactor = (takenMs, limitMs) => Math.max(0, Math.sqrt(1 - takenMs / limitMs));

export class FatafatError extends Error {
  constructor(message, code = 'fatafat_error') {
    super(message);
    this.code = code;
  }
}

/** A fresh round for one player. The seed is the round. */
/** Every question this player has already been asked, by id. */
export async function seenQuestionIds(playerId) {
  const { rows } = await query(
    `SELECT DISTINCT a.question_id
       FROM fatafat_answers a
       JOIN fatafat_rounds r ON r.id = a.round_id
      WHERE r.player_id = $1`,
    [playerId],
  );
  return new Set(rows.map((r) => r.question_id));
}

export async function createRound(playerId, lang = 'en') {
  const seed = Math.floor(Math.random() * 2147483647);

  // Nobody gets the same question twice. At ten a round against a bank this
  // size that is roughly 1,900 rounds before anyone could exhaust it; if they
  // ever do, the round still gets ten questions and simply allows repeats.
  const seen = await seenQuestionIds(playerId);
  const questions = buildRound(seed, QUESTIONS, seen);
  const ids = questions.map((q) => q.id);
  const repeated = ids.filter((id) => seen.has(id)).length;
  if (repeated) {
    log.warn('fatafat bank exhausted for player - repeating questions', {
      playerId, repeated, seen: seen.size, bank: bankSize(),
    });
  }

  const { rows } = await query(
    `INSERT INTO fatafat_rounds (player_id, seed, question_count, time_limit_ms, lang, question_ids)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [playerId, seed, QUESTIONS, TIME_LIMIT_MS, lang === 'hi' ? 'hi' : 'en', ids],
  );
  log.info('fatafat round created', { roundId: rows[0].id, playerId });
  return rows[0];
}

export async function getRound(roundId) {
  const { rows } = await query('SELECT * FROM fatafat_rounds WHERE id = $1', [roundId]);
  return rows[0] ?? null;
}

export async function answersFor(roundId) {
  const { rows } = await query(
    'SELECT * FROM fatafat_answers WHERE round_id = $1 ORDER BY seq', [roundId],
  );
  return rows;
}

/**
 * The questions of a round, rebuilt from its seed.
 *
 * Always the English original. Correctness is decided against these, and a
 * translation must never be able to change which option is right - so Hindi is
 * applied only where a question is shown, never where one is judged.
 */
export function questionsOf(round) {
  const ids = round.question_ids || [];
  if (!ids.length) return buildRound(Number(round.seed), round.question_count);   // rounds from before ids were stored

  // Rebuilt from what was written down, so a report reads the same in a year
  // as it did on the day. The twist sits where the builder puts it.
  const twistAt = Math.max(3, Math.floor(round.question_count * 0.7));
  return ids.map((id, i) => {
    const q = questionById(id);
    if (!q) return null;
    return { ...q, seq: i + 1, twist: i === twistAt && q.twistEligible };
  }).filter(Boolean);
}

/** The same question, in the language the round is being played in. */
const shown = (round, q) => (round.lang === 'hi' ? localise(q) : q);

/**
 * The next question, as the page is allowed to see it.
 *
 * `correctPositions` is deliberately absent. Everything else the page needs to
 * draw the question is here.
 */
export async function serveNext(round) {
  const answered = await answersFor(round.id);
  const seq = answered.length + 1;

  if (seq > round.question_count) return { done: true };

  const question = questionsOf(round)[seq - 1];

  // Remembered so the answer can be judged against when it was actually asked.
  await query(
    `UPDATE fatafat_rounds
        SET current_seq = $2, served_at = now(),
            started_at = COALESCE(started_at, now())
      WHERE id = $1`,
    [round.id, seq],
  );

  return {
    done: false,
    seq,
    total: round.question_count,
    timeLimitMs: round.time_limit_ms,
    question: {
      id: question.id,
      mode: question.mode,
      difficulty: question.difficulty,
      instruction: shown(round, question).instruction,
      options: shown(round, question).options,
      // How many taps the answer needs, so the page knows to wait for a second
      // one. Which slots those are is never sent.
      taps: question.mode === 'except' ? 2 : 1,
      // Whether the options are about to be shuffled under them. The page has
      // to know to run the animation; it still learns nothing about the answer.
      twist: !!question.twist,
    },
  };
}

/**
 * Judge one answer.
 *
 * `tapped` is the slots the player touched, in order. An empty array means
 * they touched nothing - which is right on a no-go and wrong everywhere else.
 */
export async function submitAnswer(round, seq, tapped, clientMs) {
  if (round.status !== 'open') throw new FatafatError('This round is already over', 'round_closed');
  if (seq !== round.current_seq) throw new FatafatError('That is not the current question', 'out_of_step');

  const already = await query(
    'SELECT 1 FROM fatafat_answers WHERE round_id = $1 AND seq = $2', [round.id, seq],
  );
  if (already.rows.length) throw new FatafatError('Already answered', 'duplicate');

  const question = questionsOf(round)[seq - 1];
  const limit = round.time_limit_ms;

  const serverMs = round.served_at
    ? Math.max(0, Date.now() - new Date(round.served_at).getTime())
    : null;

  const chosen = [...new Set((tapped ?? []).map(Number).filter((n) => n >= 1 && n <= 3))].sort();
  const want = [...question.correctPositions].sort();

  // The player's stopwatch, bounded by the question itself. A page claiming a
  // time longer than the limit has simply timed out.
  let takenMs = Number.isFinite(clientMs) ? Math.round(clientMs) : null;
  if (takenMs === null || takenMs < 0) takenMs = serverMs;
  if (takenMs !== null) takenMs = Math.min(takenMs, limit);

  const touchedNothing = chosen.length === 0;
  const noGo = isNoGo(question);

  let correct;
  if (noGo) {
    // The only question where doing nothing wins.
    correct = touchedNothing;
  } else if (touchedNothing) {
    correct = false;                       // ran out of clock
  } else if (takenMs !== null && takenMs < FLOOR_MS) {
    // Under the floor nobody has read anything - this is a pre-tap, and a
    // lucky pre-tap must not pay. It is the same rule that stops a panicking
    // player from out-scoring a thinking one.
    correct = false;
  } else if (question.mode === 'except') {
    correct = chosen.length === 2 && chosen.join() === want.join();
  } else {
    correct = chosen.length === 1 && want.includes(chosen[0]);
  }

  // The streak is the run immediately before this answer.
  const prior = await answersFor(round.id);
  let run = 0;
  for (const a of prior) run = a.was_correct ? run + 1 : 0;

  let points = 0;
  if (correct) {
    const mult = streakMult(run + 1);
    // A no-go scores flat: being right means waiting out the clock, so there
    // is no speed in it to reward. Scoring it on time would make the hardest
    // mode in the game the least rewarding.
    points = noGo
      ? question.points * mult
      : question.points * speedFactor(takenMs ?? limit, limit) * mult;
  }

  await query(
    `INSERT INTO fatafat_answers
       (round_id, seq, question_id, mode, difficulty, tapped, was_correct,
        taken_ms, server_ms, twisted, points)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [round.id, seq, question.id, question.mode, question.difficulty,
     chosen.join(','), correct, takenMs, serverMs, !!question.twist, points.toFixed(2)],
  );

  const done = seq >= round.question_count;
  if (done) await finishRound(round.id);

  return {
    correct,
    // Told only after the answer is in, never before.
    correctPositions: question.correctPositions,
    noGo,
    points: Number(points.toFixed(2)),
    takenMs,
    streak: correct ? run + 1 : 0,
    done,
  };
}

export async function finishRound(roundId) {
  const { rows } = await query(
    `UPDATE fatafat_rounds r
        SET status = 'finished',
            finished_at = now(),
            score = COALESCE((SELECT sum(points) FROM fatafat_answers a WHERE a.round_id = r.id), 0)
      WHERE id = $1 AND status = 'open'
      RETURNING *`,
    [roundId],
  );
  if (rows[0]) log.info('fatafat round finished', { roundId, score: rows[0].score });
  return rows[0] ?? getRound(roundId);
}

/** The most a round could have been worth, for the percentage on the report. */
export function maxScoreOf(round) {
  const questions = questionsOf(round);
  let total = 0;
  questions.forEach((q, i) => {
    const mult = streakMult(i + 1);
    total += isNoGo(q) ? q.points * mult : q.points * speedFactor(FLOOR_MS, round.time_limit_ms) * mult;
  });
  return total;
}

/**
 * Everything the report page draws.
 *
 * Assembled here rather than in the page so the same numbers can later feed a
 * WhatsApp summary and the admin panel without a second, differently-shaped
 * calculation that quietly disagrees.
 */
export async function roundReport(roundId) {
  const round = await getRound(roundId);
  if (!round) return null;

  const answers = await answersFor(roundId);
  const questions = questionsOf(round);

  const rows = answers.map((a) => {
    const q = questions[a.seq - 1];
    const view = shown(round, q);
    return {
      seq: a.seq,
      instruction: view.instruction,
      options: view.options,
      mode: a.mode,
      difficulty: a.difficulty,
      noGo: isNoGo(q),
      correctPositions: q.correctPositions,
      tapped: a.tapped === '' ? [] : a.tapped.split(',').map(Number),
      wasCorrect: a.was_correct,
      takenMs: a.taken_ms === null ? null : Number(a.taken_ms),
      serverMs: a.server_ms === null ? null : Number(a.server_ms),
      twisted: a.twisted,
      points: Number(a.points),
      trap: q.trap,
      // Tapped the right thing, but before anyone could have read it. Without
      // this flag the report shows "you tapped RIGHT, answer was RIGHT" in red
      // and looks broken rather than strict.
      preTap: !a.was_correct && a.tapped !== '' &&
              a.taken_ms !== null && Number(a.taken_ms) < FLOOR_MS,
    };
  });

  const correct = rows.filter((r) => r.wasCorrect);
  // Speed is only meaningful where speed was possible. A no-go answered
  // correctly took the whole clock by definition, and averaging it in would
  // make restraint look like slowness.
  const timed = correct.filter((r) => !r.noGo && r.takenMs !== null);
  const times = timed.map((r) => r.takenMs).sort((a, b) => a - b);

  const avg = times.length ? Math.round(times.reduce((s, t) => s + t, 0) / times.length) : null;
  const median = times.length ? times[Math.floor(times.length / 2)] : null;
  const fastest = times.length ? times[0] : null;
  const slowest = times.length ? times[times.length - 1] : null;
  // Spread says something the average cannot: whether a player is steady or
  // erratic. Two players averaging 700ms are not the same player if one ranges
  // 650-750 and the other 300-1400.
  const spread = times.length > 1
    ? Math.round(Math.sqrt(times.reduce((s, t) => s + (t - avg) ** 2, 0) / times.length))
    : null;

  let best = 0, run = 0;
  for (const r of rows) { run = r.wasCorrect ? run + 1 : 0; best = Math.max(best, run); }

  const noGos = rows.filter((r) => r.noGo);
  const max = maxScoreOf(round);

  return {
    round: {
      id: round.id,
      status: round.status,
      score: Number(round.score),
      maxScore: Math.round(max),
      pct: max ? Math.round((Number(round.score) / max) * 1000) : 0,
      questionCount: round.question_count,
      timeLimitMs: round.time_limit_ms,
      createdAt: round.created_at,
      finishedAt: round.finished_at,
    },
    totals: {
      answered: rows.length,
      correct: correct.length,
      wrong: rows.filter((r) => !r.wasCorrect && r.tapped.length > 0).length,
      missed: rows.filter((r) => !r.wasCorrect && r.tapped.length === 0).length,
      accuracyPct: rows.length ? Math.round((correct.length / rows.length) * 100) : 0,
      bestStreak: best,
      noGosFaced: noGos.length,
      noGosHeld: noGos.filter((r) => r.wasCorrect).length,
      twistFaced: rows.filter((r) => r.twisted).length,
      twistSurvived: rows.filter((r) => r.twisted && r.wasCorrect).length,
    },
    timing: { avgMs: avg, medianMs: median, fastestMs: fastest, slowestMs: slowest, spreadMs: spread },
    rows,
    insights: insightsFor(rows, { avg, spread, best }),
  };
}

/**
 * What the numbers actually mean, in a sentence each.
 *
 * Deliberately few. A report that says eight things says nothing; the two or
 * three that are true of THIS round are what a player reads out to a friend.
 */
function insightsFor(rows, { avg, spread, best }) {
  const out = [];
  const correct = rows.filter((r) => r.wasCorrect);
  const noGos = rows.filter((r) => r.noGo);
  const heldAll = noGos.length > 0 && noGos.every((r) => r.wasCorrect);
  const tappedOnNoGo = noGos.filter((r) => !r.wasCorrect).length;
  const timed = correct.filter((r) => !r.noGo && r.takenMs !== null);

  if (correct.length === rows.length && rows.length) {
    out.push({ tone: 'good', text: 'A clean sweep — every single question right.' });
  }
  if (heldAll && noGos.length) {
    out.push({ tone: 'good', text: `You resisted all ${noGos.length} no-go questions. That is the hard part.` });
  }
  if (tappedOnNoGo) {
    out.push({
      tone: 'bad',
      text: `You tapped on ${tappedOnNoGo} question${tappedOnNoGo > 1 ? 's' : ''} where the right answer was to touch nothing.`,
    });
  }
  if (avg !== null && avg < 600) {
    out.push({ tone: 'good', text: `Averaging ${avg}ms — genuinely quick for a three-option choice.` });
  } else if (avg !== null && avg > 1800) {
    out.push({ tone: 'flat', text: `Averaging ${avg}ms. Accurate, but there is time to be won here.` });
  }
  if (spread !== null && avg !== null && spread > avg * 0.5) {
    out.push({ tone: 'flat', text: 'Your timing swings a lot between questions — steadier beats faster.' });
  }
  if (best >= rows.length && rows.length) {
    /* covered by the clean sweep line */
  } else if (best >= Math.ceil(rows.length * 0.6)) {
    out.push({ tone: 'good', text: `Longest run: ${best} in a row.` });
  }
  const twisted = rows.find((r) => r.twisted);
  if (twisted) {
    out.push({
      tone: twisted.wasCorrect ? 'good' : 'flat',
      text: twisted.wasCorrect
        ? 'The options shuffled under you and you still got it.'
        : 'The options shuffled under you on one question. Everybody falls for it once.',
    });
  }
  const late = timed.filter((r) => r.takenMs > 3500).length;
  if (!out.length && late) out.push({ tone: 'flat', text: 'Solid round. Speed is the next thing to work on.' });
  if (!out.length) out.push({ tone: 'flat', text: 'A steady round.' });
  return out.slice(0, 4);
}

/** The player's own recent rounds, for the report's trend line. */
export async function recentRounds(playerId, limit = 10) {
  const { rows } = await query(
    `SELECT id, score, created_at, finished_at, status
       FROM fatafat_rounds
      WHERE player_id = $1 AND status = 'finished'
      ORDER BY created_at DESC
      LIMIT $2`,
    [playerId, limit],
  );
  return rows.map((r) => ({ ...r, score: Number(r.score) }));
}

/**
 * A player's Tap Bakra record, for the dashboard they see before playing.
 *
 * One query rather than five: this runs on every visit to the lobby, and the
 * lobby is the screen standing between somebody and the thing they came to do.
 *
 * Only finished rounds count. A round abandoned halfway would otherwise drag
 * an average down for a reason the player would never guess at - they closed
 * a tab once - and a statistic nobody can explain is worse than no statistic.
 */
export async function playerStats(playerId) {
  const { rows } = await query(
    `WITH mine AS (
       SELECT r.id, r.score, r.created_at
         FROM fatafat_rounds r
        WHERE r.player_id = $1 AND r.status = 'finished'
     ),
     per_round AS (
       SELECT m.id, m.score, m.created_at,
              count(*) FILTER (WHERE a.was_correct)                       AS correct,
              count(*)                                                    AS answered,
              avg(a.taken_ms) FILTER (WHERE a.was_correct AND a.mode <> 'hold') AS avg_ms,
              min(a.taken_ms) FILTER (WHERE a.was_correct AND a.mode <> 'hold') AS best_ms
         FROM mine m
         JOIN fatafat_answers a ON a.round_id = m.id
        GROUP BY m.id, m.score, m.created_at
     )
     SELECT count(*)::int                        AS rounds,
            COALESCE(max(score), 0)              AS best_score,
            COALESCE(round(avg(score)), 0)       AS avg_score,
            COALESCE(sum(correct), 0)::int       AS total_correct,
            COALESCE(sum(answered), 0)::int      AS total_answered,
            round(avg(avg_ms))                   AS avg_ms,
            min(best_ms)                         AS best_ms,
            min(created_at)                      AS first_played,
            max(created_at)                      AS last_played
       FROM per_round`,
    [playerId],
  );

  const s = rows[0] ?? {};
  const recent = await recentRounds(playerId, 12);

  // The longest run of correct answers the player has ever had, across every
  // round - the one number that makes somebody want another go.
  const { rows: streak } = await query(
    `SELECT round_id, seq, was_correct
       FROM fatafat_answers a
      WHERE a.round_id IN (SELECT id FROM fatafat_rounds WHERE player_id = $1 AND status = 'finished')
      ORDER BY round_id, seq`,
    [playerId],
  );
  let best = 0, run = 0, lastRound = null;
  for (const a of streak) {
    if (a.round_id !== lastRound) { run = 0; lastRound = a.round_id; }
    run = a.was_correct ? run + 1 : 0;
    best = Math.max(best, run);
  }

  return {
    rounds: Number(s.rounds || 0),
    bestScore: Math.round(Number(s.best_score || 0)),
    avgScore: Math.round(Number(s.avg_score || 0)),
    accuracyPct: Number(s.total_answered) ? Math.round((Number(s.total_correct) / Number(s.total_answered)) * 100) : null,
    avgMs: s.avg_ms === null || s.avg_ms === undefined ? null : Math.round(Number(s.avg_ms)),
    bestMs: s.best_ms === null || s.best_ms === undefined ? null : Math.round(Number(s.best_ms)),
    bestStreak: best,
    firstPlayed: s.first_played ?? null,
    lastPlayed: s.last_played ?? null,
    // Oldest first, so the sparkline reads left to right like a calendar.
    recentScores: recent.map((r) => Math.round(r.score)).reverse(),
  };
}

/**
 * The deeper analytics behind the dashboard's Analytics panel.
 *
 * Split by mode, because "78% accurate" hides the only interesting thing about
 * a player: almost everyone is good at TAP X and bad at the no-go questions,
 * and the gap between those two numbers is the whole skill of this game.
 */
export async function playerAnalytics(playerId) {
  const { rows: byMode } = await query(
    `SELECT a.mode,
            count(*)::int                                        AS asked,
            count(*) FILTER (WHERE a.was_correct)::int           AS correct,
            round(avg(a.taken_ms) FILTER (WHERE a.was_correct AND a.mode <> 'hold')) AS avg_ms
       FROM fatafat_answers a
       JOIN fatafat_rounds r ON r.id = a.round_id
      WHERE r.player_id = $1 AND r.status = 'finished'
      GROUP BY a.mode
      ORDER BY count(*) DESC`,
    [playerId],
  );

  const { rows: byDifficulty } = await query(
    `SELECT a.difficulty,
            count(*)::int                              AS asked,
            count(*) FILTER (WHERE a.was_correct)::int AS correct,
            round(avg(a.taken_ms) FILTER (WHERE a.was_correct AND a.mode <> 'hold')) AS avg_ms
       FROM fatafat_answers a
       JOIN fatafat_rounds r ON r.id = a.round_id
      WHERE r.player_id = $1 AND r.status = 'finished'
      GROUP BY a.difficulty ORDER BY a.difficulty`,
    [playerId],
  );

  // Per day, for the activity strip. Dates in the operator's timezone, not
  // UTC - a round played at 1am IST belongs to that day, not the one before.
  const { rows: byDay } = await query(
    `SELECT (r.created_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
            count(*)::int                                    AS rounds,
            round(avg(r.score))                              AS avg_score,
            max(r.score)                                     AS best_score
       FROM fatafat_rounds r
      WHERE r.player_id = $1 AND r.status = 'finished'
      GROUP BY 1 ORDER BY 1 DESC LIMIT 30`,
    [playerId],
  );

  /* Are they getting better? First five finished rounds against the last five.
     Fewer than six rounds and the question cannot honestly be answered. */
  const recent = await recentRounds(playerId, 500);
  let improvement = { enough: false, needed: 6, have: recent.length };
  if (recent.length >= 6) {
    const n = Math.min(5, Math.floor(recent.length / 2));
    const avg = (xs) => Math.round(xs.reduce((s, r) => s + r.score, 0) / xs.length);
    const now = avg(recent.slice(0, n));
    const before = avg(recent.slice(-n));
    improvement = {
      enough: true, window: n, now, before,
      delta: now - before,
      direction: now > before * 1.05 ? 'up' : now < before * 0.95 ? 'down' : 'flat',
    };
  }

  const num = (v) => (v === null || v === undefined ? null : Number(v));
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
    byDay: byDay.map((d) => ({
      day: d.day instanceof Date ? d.day.toISOString().slice(0, 10) : String(d.day),
      rounds: d.rounds, avgScore: num(d.avg_score), bestScore: num(d.best_score),
    })).reverse(),
    improvement,
  };
}

/** Recent rounds with enough on each row to list them and link to the report. */
export async function roundList(playerId, limit = 20) {
  const { rows } = await query(
    `SELECT r.id, r.score, r.created_at, r.finished_at, r.lang, r.question_count,
            count(a.*) FILTER (WHERE a.was_correct)::int AS correct,
            count(a.*)::int                              AS answered
       FROM fatafat_rounds r
       LEFT JOIN fatafat_answers a ON a.round_id = r.id
      WHERE r.player_id = $1 AND r.status = 'finished'
      GROUP BY r.id
      ORDER BY r.created_at DESC
      LIMIT $2`,
    [playerId, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    score: Math.round(Number(r.score)),
    correct: r.correct,
    answered: r.answered,
    lang: r.lang,
    playedAt: r.finished_at ?? r.created_at,
  }));
}
