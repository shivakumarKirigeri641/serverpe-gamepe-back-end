/**
 * Hand Cricket: the rules, the bot, and friend matches.
 *
 * The game everybody played on a school bench. Each ball both sides show a
 * number from 1 to 6 at the same time; the same number is OUT, anything else
 * and the batter scores their number. Two overs and two wickets an innings,
 * then the other side chases.
 *
 * ── Who sees what ─────────────────────────────────────────────────────────
 *
 * A pick waiting for the other side is held in the row (pick1 / pick2) and is
 * never part of what the opponent's page receives - only "they have picked".
 * Both are revealed together once the ball is resolved. Against a friend that
 * is the only thing that makes the game honest; against the bot it is what
 * keeps the bot honest too, because the bot chooses BEFORE it is told the
 * player's pick, from the balls already played and nothing else.
 *
 * ── Sides ─────────────────────────────────────────────────────────────────
 *
 * Side 1 is whoever started the match. Side 2 is the bot, or the friend who
 * joined with the code. Scores are kept by INNINGS (runs1 is the first
 * innings, whoever batted in it), which is how a scorecard reads.
 *
 * Everything that changes a match happens inside one transaction holding the
 * row lock, so two taps arriving together - or both friends picking in the
 * same instant - resolve exactly one ball.
 */
import { query, withTransaction, isUniqueViolation } from '../db/pool.js';
import { log } from '../utils/logger.js';
import { generateRoomCode } from '../utils/code.js';
import { getPlayerById, displayNameFor } from './player.service.js';

export const OVERS = 2;
export const WICKETS = 2;
export const LEVELS = ['easy', 'medium', 'hard'];

/** How long a friend match may sit untouched before it is called off. */
const STALE_MINUTES = { waiting: 30, live: 15 };

export class CricketError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.code = code;
  }
}

const other = (side) => (side === 1 ? 2 : 1);
const battingSide = (m) => (m.innings === 1 ? m.bat_first : other(m.bat_first));
/** The side that calls the toss: the player against the bot, the invited friend in a friend match. */
const tossCaller = (m) => (m.mode === 'bot' ? 1 : 2);

/* ── creating and joining ─────────────────────────────────────────────── */

export async function createBotMatch(playerId, level = 'medium', lang = 'en') {
  const lvl = LEVELS.includes(level) ? level : 'medium';
  const { rows } = await query(
    `INSERT INTO cricket_matches (mode, host_player_id, bot_level, overs, wickets, status, lang, started_at)
     VALUES ('bot', $1, $2, $3, $4, 'toss', $5, now()) RETURNING *`,
    [playerId, lvl, OVERS, WICKETS, lang === 'hi' ? 'hi' : 'en'],
  );
  log.info('cricket bot match created', { matchId: rows[0].id, playerId, level: lvl });
  return rows[0];
}

/** A friend match waits for the other player with a six-character code. */
export async function createFriendMatch(playerId, lang = 'en', { guestPlayerId = null } = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const { rows } = await query(
        `INSERT INTO cricket_matches (mode, code, host_player_id, guest_player_id, overs, wickets, status, lang, started_at)
         VALUES ('friend', $1, $2, $3, $4, $5, $6, $7, CASE WHEN $3::bigint IS NULL THEN NULL ELSE now() END) RETURNING *`,
        [generateRoomCode(), playerId, guestPlayerId, OVERS, WICKETS, guestPlayerId ? 'toss' : 'waiting', lang === 'hi' ? 'hi' : 'en'],
      );
      log.info('cricket friend match created', { matchId: rows[0].id, playerId, code: rows[0].code });
      return rows[0];
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;      // another match took the code: draw again
    }
  }
  throw new CricketError('Could not create a match code - please try again.', 'code_busy');
}

/**
 * Join a friend match by its code. The host opening their own code gets their
 * own seat back; a second tap by the friend gets theirs. A third person is
 * told the match is full rather than quietly replacing anybody.
 */
export async function joinByCode(code, playerId) {
  return withTransaction(async (c) => {
    const { rows } = await c.query(`SELECT * FROM cricket_matches WHERE code = $1 FOR UPDATE`, [code]);
    const m = rows[0];
    if (!m) throw new CricketError('No match with that code. Check it with your friend.', 'not_found');
    if (Number(m.host_player_id) === Number(playerId)) return m;
    if (m.guest_player_id && Number(m.guest_player_id) === Number(playerId)) return m;
    if (m.guest_player_id) throw new CricketError('This match already has two players.', 'full');
    if (m.status !== 'waiting') throw new CricketError('This match is no longer open.', 'closed');
    const { rows: up } = await c.query(
      `UPDATE cricket_matches SET guest_player_id = $2, status = 'toss', started_at = now(), last_move_at = now()
        WHERE id = $1 RETURNING *`, [m.id, playerId]);
    log.info('cricket friend joined', { matchId: m.id, playerId });
    return up[0];
  });
}

export async function getMatch(id) {
  const { rows } = await query('SELECT * FROM cricket_matches WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/** 1 or 2 for a player in this match, null for anybody else. */
export function sideOf(m, playerId) {
  if (Number(m.host_player_id) === Number(playerId)) return 1;
  if (m.guest_player_id && Number(m.guest_player_id) === Number(playerId)) return 2;
  return null;
}

/**
 * A friend match nobody has touched for a while is called off, so a page left
 * open does not wait forever for a friend who closed the tab. Done when the
 * match is read; there is no job to keep in step.
 */
async function expireIfStale(m) {
  if (m.mode !== 'friend' || ['finished', 'abandoned'].includes(m.status)) return m;
  const minutes = m.status === 'waiting' ? STALE_MINUTES.waiting : STALE_MINUTES.live;
  const { rows } = await query(
    `UPDATE cricket_matches SET status = 'abandoned', finished_at = now(), result = 'Called off - nobody played for a while'
      WHERE id = $1 AND status = $2 AND last_move_at < now() - ($3 || ' minutes')::interval RETURNING *`,
    [m.id, m.status, String(minutes)]);
  return rows[0] ?? m;
}

/* ── the bot ──────────────────────────────────────────────────────────── */

/**
 * What the player is likely to show next, from what they showed before in the
 * same role. Smoothed so a new player starts as "anything", with extra weight
 * for repeating the last number and for what usually followed it - the two
 * habits people actually have.
 */
function predict(seq) {
  const w = [0, 1, 1, 1, 1, 1, 1];
  seq.forEach((p) => { w[p] += 1; });
  const last = seq[seq.length - 1];
  if (last) {
    w[last] += 1.5;
    for (let i = 0; i < seq.length - 1; i++) if (seq[i] === last) w[seq[i + 1]] += 2;
  }
  const total = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / total);
}

const STRENGTH = { easy: 0, medium: 0.55, hard: 0.85 };
const rand6 = () => 1 + Math.floor(Math.random() * 6);

/**
 * The bot's number for this ball. It sees the balls already played and never
 * the pick it is answering. Easy is pure chance; medium and hard read habits.
 */
function botPick(m, balls) {
  const strength = STRENGTH[m.bot_level] ?? STRENGTH.medium;
  if (Math.random() >= strength) return rand6();
  const botBatting = battingSide(m) === 2;
  // The player's own numbers in the role they are playing now.
  const seq = balls.filter((b) => (botBatting ? b.batter === 2 : b.batter === 1))
    .map((b) => (botBatting ? b.bowl_pick : b.bat_pick));
  const p = predict(seq);
  if (!botBatting) {
    // Bowling: show the number the batter is most likely to show.
    let best = 1;
    for (let n = 2; n <= 6; n++) if (p[n] > p[best] || (p[n] === p[best] && Math.random() < 0.5)) best = n;
    return best;
  }
  // Batting: runs if not out, minus what a wicket costs.
  let best = 1; let score = -Infinity;
  for (let n = 1; n <= 6; n++) {
    const s = n * (1 - p[n]) - p[n] * 6;
    if (s > score) { score = s; best = n; }
  }
  return best;
}

/* ── moves ────────────────────────────────────────────────────────────── */

async function lockMatch(c, matchId) {
  const { rows } = await c.query('SELECT * FROM cricket_matches WHERE id = $1 FOR UPDATE', [matchId]);
  if (!rows[0]) throw new CricketError('Match not found.', 'not_found');
  return rows[0];
}

async function ballsOf(c, matchId) {
  const { rows } = await c.query(
    'SELECT innings, ball_no, batter, bat_pick, bowl_pick, runs, is_out FROM cricket_balls WHERE match_id = $1 ORDER BY innings, ball_no',
    [matchId]);
  return rows;
}

function resultText(m, names) {
  if (m.winner === 0) return 'Match tied';
  const name = names[m.winner];
  const chasing = other(m.bat_first);
  if (m.winner === chasing) {
    const left = m.wickets - m.wkts2;
    return `${name} won by ${left} wicket${left === 1 ? '' : 's'}`;
  }
  const by = m.runs1 - m.runs2;
  return `${name} won by ${by} run${by === 1 ? '' : 's'}`;
}

async function sideNames(m) {
  const host = await getPlayerById(m.host_player_id);
  const guest = m.mode === 'bot' ? null : (m.guest_player_id ? await getPlayerById(m.guest_player_id) : null);
  return {
    1: host ? displayNameFor(host) : 'Player',
    2: m.mode === 'bot' ? `Bot (${m.bot_level})` : (guest ? displayNameFor(guest) : 'Friend'),
  };
}

/** Both numbers are in: settle the toss or the ball, and move the match on. */
async function resolve(c, m) {
  const p1 = m.pick1; const p2 = m.pick2;

  if (m.status === 'toss') {
    const odd = (p1 + p2) % 2 === 1;
    const caller = tossCaller(m);
    const winner = (odd ? 'odd' : 'even') === m.toss_call ? caller : other(caller);
    // The bot decides on the spot: it likes to chase, unless it is the easy one, who flips a coin.
    if (m.mode === 'bot' && winner === 2) {
      const bat = m.bot_level === 'easy' ? Math.random() < 0.5 : false;
      const { rows } = await c.query(
        `UPDATE cricket_matches SET toss_winner = 2, bat_first = $2, status = 'playing', pick1 = NULL, pick2 = NULL,
                turn = turn + 1, last_move_at = now(), result = $3 WHERE id = $1 RETURNING *`,
        [m.id, bat ? 2 : 1, `toss:${p1}+${p2}`]);
      return rows[0];
    }
    const { rows } = await c.query(
      `UPDATE cricket_matches SET toss_winner = $2, status = 'choose', pick1 = NULL, pick2 = NULL,
              turn = turn + 1, last_move_at = now(), result = $3 WHERE id = $1 RETURNING *`,
      [m.id, winner, `toss:${p1}+${p2}`]);
    return rows[0];
  }

  // A ball.
  const bat = battingSide(m);
  const batPick = bat === 1 ? p1 : p2;
  const bowlPick = bat === 1 ? p2 : p1;
  const out = batPick === bowlPick;
  const runs = out ? 0 : batPick;
  const i = m.innings;
  const next = { ...m };
  next[`runs${i}`] = m[`runs${i}`] + runs;
  next[`wkts${i}`] = m[`wkts${i}`] + (out ? 1 : 0);
  next[`balls${i}`] = m[`balls${i}`] + 1;
  await c.query(
    `INSERT INTO cricket_balls (match_id, innings, ball_no, batter, bat_pick, bowl_pick, runs, is_out)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [m.id, i, next[`balls${i}`], bat, batPick, bowlPick, runs, out]);

  const maxBalls = m.overs * 6;
  let status = 'playing'; let innings = i; let winner = null;
  if (i === 1) {
    if (next.wkts1 >= m.wickets || next.balls1 >= maxBalls) innings = 2;
  } else if (next.runs2 > next.runs1) {
    status = 'finished'; winner = bat;
  } else if (next.wkts2 >= m.wickets || next.balls2 >= maxBalls) {
    status = 'finished';
    winner = next.runs2 === next.runs1 ? 0 : m.bat_first;
  }
  next.status = status; next.innings = innings; next.winner = winner;
  const result = status === 'finished' ? resultText(next, await sideNames(m)) : null;

  const { rows } = await c.query(
    `UPDATE cricket_matches
        SET runs1 = $2, wkts1 = $3, balls1 = $4, runs2 = $5, wkts2 = $6, balls2 = $7,
            innings = $8, status = $9, winner = $10, result = COALESCE($11, result),
            finished_at = CASE WHEN $9 = 'finished' THEN now() ELSE finished_at END,
            pick1 = NULL, pick2 = NULL, turn = turn + 1, last_move_at = now()
      WHERE id = $1 RETURNING *`,
    [m.id, next.runs1, next.wkts1, next.balls1, next.runs2, next.wkts2, next.balls2, innings, status, winner, result]);
  return rows[0];
}

/**
 * A player shows their number - for the toss or for a ball. `turn` is the turn
 * their page was answering; an old one is refused instead of being counted
 * twice. Against the bot the bot answers at once and the ball is settled in
 * the same call.
 */
export async function pick(matchId, side, n, turn, call = null) {
  const num = Number(n);
  if (!Number.isInteger(num) || num < 1 || num > 6) throw new CricketError('Pick a number from 1 to 6.', 'bad_pick');
  return withTransaction(async (c) => {
    let m = await lockMatch(c, matchId);
    if (!['toss', 'playing'].includes(m.status)) throw new CricketError('Nothing to pick right now.', 'not_now');
    if (Number(turn) !== m.turn) throw new CricketError('That ball has already been played.', 'stale');
    if (m[`pick${side}`] !== null) throw new CricketError('You have already picked - waiting for the other side.', 'already');

    if (m.status === 'toss' && side === tossCaller(m)) {
      if (!['odd', 'even'].includes(call) && !m.toss_call) throw new CricketError('Call odd or even first.', 'call_needed');
      if (!m.toss_call) await c.query('UPDATE cricket_matches SET toss_call = $2 WHERE id = $1', [m.id, call]);
      m.toss_call = m.toss_call || call;
    }

    m[`pick${side}`] = num;
    if (m.mode === 'bot') {
      const balls = m.status === 'playing' ? await ballsOf(c, m.id) : [];
      m.pick2 = m.status === 'toss' ? rand6() : botPick(m, balls);
    }
    await c.query('UPDATE cricket_matches SET pick1 = $2, pick2 = $3, last_move_at = now() WHERE id = $1',
      [m.id, m.pick1, m.pick2]);

    if (m.pick1 !== null && m.pick2 !== null) m = await resolve(c, m);
    return m;
  });
}

/** The toss winner chooses to bat or bowl first. */
export async function choose(matchId, side, choice) {
  if (!['bat', 'bowl'].includes(choice)) throw new CricketError('Choose bat or bowl.', 'bad_choice');
  return withTransaction(async (c) => {
    const m = await lockMatch(c, matchId);
    if (m.status !== 'choose') throw new CricketError('The toss is already decided.', 'not_now');
    if (m.toss_winner !== side) throw new CricketError('The toss winner chooses.', 'not_yours');
    const batFirst = choice === 'bat' ? side : other(side);
    const { rows } = await c.query(
      `UPDATE cricket_matches SET bat_first = $2, status = 'playing', turn = turn + 1, last_move_at = now()
        WHERE id = $1 RETURNING *`, [m.id, batFirst]);
    return rows[0];
  });
}

/**
 * Play again. Against the bot, a fresh match at the same level. Against a
 * friend, a new match with the same two players, linked from the old one so
 * the friend's page offers it - whoever taps first creates it, the other
 * simply joins it.
 */
export async function rematch(matchId, playerId) {
  const m = await getMatch(matchId);
  if (!m) throw new CricketError('Match not found.', 'not_found');
  if (m.mode === 'bot') return createBotMatch(playerId, m.bot_level, m.lang);
  if (m.rematch_id) return getMatch(m.rematch_id);
  const opponent = Number(m.host_player_id) === Number(playerId) ? m.guest_player_id : m.host_player_id;
  const fresh = await createFriendMatch(playerId, m.lang, { guestPlayerId: opponent });
  const { rows } = await query(
    'UPDATE cricket_matches SET rematch_id = $2 WHERE id = $1 AND rematch_id IS NULL RETURNING rematch_id', [m.id, fresh.id]);
  if (!rows[0]) {
    // The other player got there in the same instant: theirs stands, this one goes.
    await query("UPDATE cricket_matches SET status = 'abandoned', result = 'Duplicate rematch' WHERE id = $1", [fresh.id]);
    return getMatch((await getMatch(m.id)).rematch_id);
  }
  return fresh;
}

/** Leave a match. Against a friend the other side is told the match was called off. */
export async function leave(matchId, side) {
  const { rows } = await query(
    `UPDATE cricket_matches SET status = 'abandoned', finished_at = now(), result = $2, last_move_at = now()
      WHERE id = $1 AND status NOT IN ('finished','abandoned') RETURNING *`,
    [matchId, side === 1 ? 'Side 1 left the match' : 'Side 2 left the match']);
  return rows[0] ?? getMatch(matchId);
}

/* ── what a page is shown ─────────────────────────────────────────────── */

/**
 * The match as one side sees it. The opponent's waiting pick is reduced to a
 * yes/no; everything else is the scorecard.
 */
export async function stateFor(matchRow, side) {
  const m = await expireIfStale(matchRow);
  const names = await sideNames(m);
  const { rows: balls } = await query(
    'SELECT innings, ball_no, batter, bat_pick, bowl_pick, runs, is_out FROM cricket_balls WHERE match_id = $1 ORDER BY innings, ball_no',
    [m.id]);
  const bat = m.bat_first ? battingSide(m) : null;
  const opp = other(side);
  let toss = null;
  if (m.toss_winner) {
    const [a, b] = String(m.result || '').startsWith('toss:') ? m.result.slice(5).split('+').map(Number) : [null, null];
    toss = { winner: m.toss_winner, call: m.toss_call, caller: tossCaller(m), picks: { 1: a, 2: b } };
  }
  const last = balls[balls.length - 1] || null;
  return {
    id: Number(m.id),
    mode: m.mode,
    level: m.bot_level,
    code: m.code,
    status: m.status,
    turn: m.turn,
    you: side,
    names,
    overs: m.overs,
    wickets: m.wickets,
    innings: m.innings,
    batFirst: m.bat_first,
    batting: bat,
    tossCaller: tossCaller(m),
    tossCall: m.toss_call,
    toss,
    score: {
      1: { runs: m.runs1, wkts: m.wkts1, balls: m.balls1 },
      2: { runs: m.runs2, wkts: m.wkts2, balls: m.balls2 },
    },
    target: m.innings === 2 ? m.runs1 + 1 : null,
    myPick: m[`pick${side}`],
    opponentPicked: m[`pick${opp}`] !== null,
    lastBall: last,
    balls,
    winner: m.winner,
    result: m.status === 'finished' || m.status === 'abandoned' ? m.result : null,
    rematchId: m.rematch_id ? Number(m.rematch_id) : null,
  };
}

/* ── a player's record ────────────────────────────────────────────────── */

/** Matches played, won, and the best innings - for the page and the play menu. */
export async function playerStats(playerId) {
  const { rows } = await query(
    `WITH mine AS (
       SELECT m.*, CASE WHEN m.host_player_id = $1 THEN 1 ELSE 2 END AS side
         FROM cricket_matches m
        WHERE (m.host_player_id = $1 OR m.guest_player_id = $1) AND m.status = 'finished')
     SELECT count(*)::int AS played,
            count(*) FILTER (WHERE winner = side)::int AS won,
            count(*) FILTER (WHERE winner = 0)::int AS tied,
            max(CASE WHEN bat_first = side THEN runs1 ELSE runs2 END)::int AS best
       FROM mine`, [playerId]);
  return rows[0];
}
