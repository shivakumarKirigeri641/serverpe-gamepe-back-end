/**
 * Drawing numbers, and recording what players did about them.
 *
 * The concurrency story lives here. Three things can try to advance a game at
 * the same moment: the scheduled tick, an early advance once everybody has
 * answered, and a second app process. All three go through performDraw(),
 * which takes a row lock and re-checks the cursor, so at most one of them
 * actually draws and the rest become no-ops.
 */
import { withTransaction, query } from '../db/pool.js';
import { log } from '../utils/logger.js';
import { config } from '../config/env.js';
import { taglineFor } from '../games/tambola/taglines.js';
import { broadcast, broadcastCoalesced, cancelCoalesced } from './live.service.js';
import { announceGameOver } from './gameover.service.js';

/**
 * Advances one game by exactly one number.
 *
 * @param {number} gameId
 * @param {number|null} expectedCursor  when given, the draw only happens if
 *        the game is still at this position. A tick queued before someone
 *        else drew is then correctly ignored instead of double-drawing.
 * @returns {Promise<null | {seq, value, isLast}>} null when nothing was drawn -
 *          a stale tick, a game that is not running, or the game just ending.
 */
export async function performDraw(gameId, expectedCursor = null) {
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM games WHERE id = $1 FOR UPDATE`,
      [gameId],
    );
    const game = rows[0];
    if (!game || game.status !== 'running') return null;

    // The stale-tick guard. Cheap, and the reason a delayed job can never
    // reorder or duplicate a number.
    if (expectedCursor !== null && game.cursor !== expectedCursor) {
      log.debug('stale draw ignored', { gameId, expectedCursor, actual: game.cursor });
      return null;
    }

    const sequence = game.sequence;
    const cursor = game.cursor;

    if (cursor >= sequence.length) {
      await endGame(client, gameId, 'numbers_exhausted');
      return { ended: true, reason: 'numbers_exhausted' };
    }

    const value = sequence[cursor];
    const seq = cursor + 1;

    // Anyone who never answered the previous number is recorded as
    // no_response now. ON CONFLICT DO NOTHING means players who did answer
    // keep their answer.
    if (seq > 1) {
      await client.query(
        `INSERT INTO draw_answers (game_id, seq, player_id, answer)
         SELECT $1, $2, gp.player_id, 'no_response'
           FROM game_players gp
          WHERE gp.game_id = $1 AND gp.left_at IS NULL
         ON CONFLICT (game_id, seq, player_id) DO NOTHING`,
        [gameId, seq - 1],
      );
    }

    // UNIQUE (game_id, seq) makes this the definitive record: even if two
    // processes somehow got this far, only one row can exist.
    await client.query(
      `INSERT INTO draws (game_id, seq, value) VALUES ($1, $2, $3)
       ON CONFLICT (game_id, seq) DO NOTHING`,
      [gameId, seq, value],
    );

    await client.query(
      `UPDATE games
          SET cursor = cursor + 1,
              next_draw_at = now() + make_interval(secs => draw_interval_seconds)
        WHERE id = $1`,
      [gameId],
    );

    // The 90th number is NOT the end of the game - it is the last number, and
    // it gets the same time on screen as the other 89.
    //
    // Ending here was wrong in a way players could see: the draw and the
    // game-over both went out in the same instant, so the board flipped
    // straight to the results and the last number anyone actually saw was 89.
    // Nobody could mark it, and a Full House completing on the final number
    // was unclaimable.
    //
    // Instead the cursor advances past the end as normal, and the NEXT tick
    // takes the `cursor >= sequence.length` branch above and ends the game -
    // one full draw interval later, exactly like every other number.
    return { seq, value, isLast: seq >= sequence.length };
  });

  if (!result) return null;

  if (result.ended) {
    broadcast(gameId, 'game_over', { reason: result.reason });
    announceGameOver(gameId).catch(() => {});
    return null;
  }

  broadcast(
    gameId,
    'draw',
    {
      seq: result.seq,
      value: result.value,
      tagline: taglineFor(result.value),
      intervalSeconds: config.game.drawIntervalSeconds,
    },
    result.seq,
  );

  log.info('draw', { gameId, seq: result.seq, value: result.value, last: result.isLast });
  return result;
}

async function endGame(client, gameId, reason) {
  cancelCoalesced(gameId);
  await client.query(
    `UPDATE games
        SET status = 'finished', ended_at = now(), ended_reason = $2, next_draw_at = NULL
      WHERE id = $1 AND status = 'running'`,
    [gameId, reason],
  );
}

/**
 * Records a player's Yes/No.
 *
 * Note what this does NOT do: it does not decide whether the number counts.
 * Marking is the player's own business, and claims are validated against the
 * `draws` table, so a wrong tap costs a player nothing but accuracy.
 */
export async function recordAnswer({ gameId, playerId, seq, answer }) {
  if (!['yes', 'no'].includes(answer)) {
    return { ok: false, reason: 'answer must be yes or no' };
  }

  // One round trip instead of two. Under load the number of queries per tap
  // is what decides whether the pool keeps up.
  const { rows: ctx } = await query(
    `SELECT d.value, e.ticket
       FROM draws d
       LEFT JOIN entries e ON e.game_id = d.game_id AND e.player_id = $3
      WHERE d.game_id = $1 AND d.seq = $2`,
    [gameId, seq, playerId],
  );
  if (ctx.length === 0) return { ok: false, reason: 'that number has not been called' };
  if (!ctx[0].ticket) return { ok: false, reason: 'you are not in this game' };

  const value = ctx[0].value;
  const onTicket = ctx[0].ticket.numbers.includes(value);
  const wasCorrect = (answer === 'yes') === onTicket;

  // First answer wins; a double tap does not overwrite the original.
  const { rows: inserted } = await query(
    `INSERT INTO draw_answers (game_id, seq, player_id, answer, was_correct)
          VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (game_id, seq, player_id) DO NOTHING
       RETURNING answer, was_correct`,
    [gameId, seq, playerId, answer, wasCorrect],
  );

  // No row back means an answer was already stored. Report THAT one, not the
  // one we just discarded, or the board would show feedback for a tap that
  // never counted.
  let stored = inserted[0];
  if (!stored) {
    const { rows } = await query(
      `SELECT answer, was_correct FROM draw_answers
        WHERE game_id = $1 AND seq = $2 AND player_id = $3`,
      [gameId, seq, playerId],
    );
    stored = rows[0];
  }

  const progress = await answerProgress(gameId, seq);
  await maybeAdvanceEarly(gameId, seq, progress);

  // Coalesced: a progress counter only needs a current value, and sending one
  // per answer to every board is O(players^2) writes per number.
  broadcastCoalesced(gameId, 'answers', { seq, ...progress });

  // NOTE what is deliberately absent: onTicket and wasCorrect.
  //
  // The player marks their own ticket and finds out how they did when the game
  // ends. Telling them mid-game turns every number into the server confirming
  // the answer for them, which is not the game. The truth is still recorded in
  // draw_answers, and claims are still validated against `draws`, so a wrong
  // tap costs accuracy and nothing else.
  return {
    ok: true,
    value,
    answer: stored.answer,
    alreadyAnswered: inserted.length === 0,
    ...progress,
    // Never serialised to the player - the caller pulls this out for the audit
    // trail and sends the rest.
    audit: { onTicket, wasCorrect: stored.was_correct },
  };
}

/** How many of the seated players have answered this number. */
export async function answerProgress(gameId, seq) {
  const { rows } = await query(
    `SELECT (SELECT count(*)::int FROM game_players
              WHERE game_id = $1 AND left_at IS NULL)                 AS total,
            (SELECT count(*)::int FROM draw_answers
              WHERE game_id = $1 AND seq = $2)                        AS answered`,
    [gameId, seq],
  );
  return { answered: rows[0].answered, total: rows[0].total };
}

/**
 * When every player has answered, there is no reason to sit out the rest of
 * the clock. Pull next_draw_at forward instead of drawing here directly, so
 * the scheduler stays the only thing that draws and the row lock still
 * arbitrates.
 */
async function maybeAdvanceEarly(gameId, seq, progress) {
  if (progress.answered < progress.total) return;

  await query(
    `UPDATE games
        SET next_draw_at = LEAST(next_draw_at, now() + make_interval(secs => $2))
      WHERE id = $1 AND status = 'running' AND cursor = $3`,
    [gameId, config.game.earlyAdvanceDelayMs / 1000, seq],
  );
  log.debug('early advance', { gameId, seq });
}

/** Everything called so far, in order - the source of truth for a catch-up. */
export async function getDraws(gameId, afterSeq = 0) {
  const { rows } = await query(
    'SELECT seq, value FROM draws WHERE game_id = $1 AND seq > $2 ORDER BY seq',
    [gameId, afterSeq],
  );
  return rows.map((r) => ({ seq: r.seq, value: r.value, tagline: taglineFor(r.value) }));
}

/** This player's own marks, so a reopened page shows their ticket correctly. */
export async function getAnswers(gameId, playerId) {
  const { rows } = await query(
    `SELECT d.value, a.answer
       FROM draw_answers a
       JOIN draws d ON d.game_id = a.game_id AND d.seq = a.seq
      WHERE a.game_id = $1 AND a.player_id = $2`,
    [gameId, playerId],
  );
  return rows;
}
