/**
 * Prize claims.
 *
 * Two players can tap Full House in the same instant. Nothing in application
 * code can reliably arbitrate that, so it does not try: the partial unique
 * index on claims (game_id, claim_type) WHERE status = 'awarded' decides, and
 * the transaction that loses catches 23505 and reports the prize as gone.
 */
import { withTransaction, query, isUniqueViolation } from '../db/pool.js';
import { log } from '../utils/logger.js';
import { validateClaim, eligibleClaims, getClaim, FINAL_CLAIM, CLAIMS } from '../games/tambola/claims.js';
import { displayNameFor } from './player.service.js';
import { broadcast } from './live.service.js';
import { announceGameOver } from './gameover.service.js';

/**
 * How long a claim is still accepted after the last number is called.
 *
 * Long enough for a player to read the number, find it, and tap; short enough
 * that a finished game does not stay open. Only applies when the game ended by
 * running out of numbers.
 */
const CLAIM_GRACE_MS = 20_000;

export async function attemptClaim({ gameId, playerId, claimType }) {
  // Reject an unknown prize before touching the database. The claims table has
  // a CHECK constraint on claim_type, so even writing the REJECTION row for a
  // bogus type would raise 23514 - which is exactly how a malformed request
  // once took the whole process down.
  if (!getClaim(claimType)) {
    return { ok: false, reason: 'that is not a prize in this game', claimType };
  }

  const outcome = await withTransaction(async (client) => {
    // Lock the game so the awarded-list we validate against cannot change
    // underneath us between the check and the insert.
    const { rows: gameRows } = await client.query(
      'SELECT * FROM games WHERE id = $1 FOR UPDATE',
      [gameId],
    );
    const game = gameRows[0];
    if (!game) return { ok: false, reason: 'that game does not exist' };

    // A game that ran out of numbers is already 'finished' the instant the
    // 90th is drawn - so a player whose Full House completes on that number
    // would never get to claim it. They keep a short window.
    //
    // Full House ending the game is different: that prize is gone, and there
    // is nothing left to claim.
    const inGrace =
      game.status === 'finished' &&
      game.ended_reason === 'numbers_exhausted' &&
      game.ended_at &&
      Date.now() - new Date(game.ended_at).getTime() < CLAIM_GRACE_MS;

    if (game.status !== 'running' && !inGrace) {
      return { ok: false, reason: 'the game is not running' };
    }

    const { rows: entryRows } = await client.query(
      'SELECT ticket FROM entries WHERE game_id = $1 AND player_id = $2',
      [gameId, playerId],
    );
    if (entryRows.length === 0) return { ok: false, reason: 'you are not in this game' };
    const grid = entryRows[0].ticket.grid;

    // Validate against what was CALLED, not what the player marked.
    const { rows: drawRows } = await client.query(
      'SELECT value FROM draws WHERE game_id = $1',
      [gameId],
    );
    const drawn = drawRows.map((r) => r.value);

    const { rows: awardedRows } = await client.query(
      `SELECT claim_type FROM claims WHERE game_id = $1 AND status = 'awarded'`,
      [gameId],
    );
    const alreadyAwarded = awardedRows.map((r) => r.claim_type);

    const verdict = validateClaim({ grid, claimKey: claimType, drawn, alreadyAwarded });

    if (!verdict.ok) {
      // Rejections are recorded too - useful when a player insists they won.
      await client.query(
        `INSERT INTO claims (game_id, player_id, claim_type, status, seq, reason)
              VALUES ($1, $2, $3, 'rejected', $4, $5)`,
        [gameId, playerId, claimType, game.cursor, verdict.reason],
      );
      return { ok: false, reason: verdict.reason, claimType };
    }

    try {
      await client.query(
        `INSERT INTO claims (game_id, player_id, claim_type, status, seq)
              VALUES ($1, $2, $3, 'awarded', $4)`,
        [gameId, playerId, claimType, game.cursor],
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Someone else's insert committed first. This is the race resolving
        // correctly, not an error.
        return { ok: false, reason: `${getClaim(claimType).label} has just been won by someone else`, claimType };
      }
      throw err;
    }

    const gameOver = claimType === FINAL_CLAIM;
    if (gameOver) {
      await client.query(
        `UPDATE games
            SET status = 'finished', ended_at = now(),
                ended_reason = 'full_house', next_draw_at = NULL
          WHERE id = $1`,
        [gameId],
      );
    }

    return { ok: true, claimType, label: getClaim(claimType).label, gameOver };
  });

  if (outcome.ok) {
    const { rows } = await query('SELECT * FROM players WHERE id = $1', [playerId]);
    const winner = rows[0] ? displayNameFor(rows[0]) : 'A player';

    log.info('prize awarded', { gameId, playerId, claimType });

    // Everyone finds out, immediately - that is half the fun of tambola.
    broadcast(gameId, 'claim', { claimType, label: outcome.label, winner });

    if (outcome.gameOver) {
      broadcast(gameId, 'game_over', { reason: 'full_house', winner, results: await getResults(gameId) });
      // Summaries go out after the broadcast, so the celebration is on screen
      // before the phone buzzes.
      announceGameOver(gameId).catch((err) =>
        log.error('could not announce game over', { gameId, message: err.message }));
    }
  }

  return outcome;
}

/** Which prizes are still up for grabs, and which this player could take now. */
export async function getClaimState(gameId, playerId) {
  const { rows: awardedRows } = await query(
    `SELECT c.claim_type, p.display_name, p.wa_id, c.player_id
       FROM claims c JOIN players p ON p.id = c.player_id
      WHERE c.game_id = $1 AND c.status = 'awarded'`,
    [gameId],
  );

  const awarded = {};
  for (const row of awardedRows) {
    awarded[row.claim_type] = {
      winner: displayNameFor(row),
      isYou: row.player_id === playerId,
    };
  }

  const { rows: entryRows } = await query(
    'SELECT ticket FROM entries WHERE game_id = $1 AND player_id = $2',
    [gameId, playerId],
  );
  const { rows: drawRows } = await query('SELECT value FROM draws WHERE game_id = $1', [gameId]);
  const drawn = drawRows.map((r) => r.value);

  const eligible = entryRows.length
    ? eligibleClaims(entryRows[0].ticket.grid, drawn, Object.keys(awarded))
    : [];

  return {
    prizes: CLAIMS.map((c) => ({
      key: c.key,
      label: c.label,
      hint: c.hint,
      awarded: awarded[c.key] ?? null,
      eligible: eligible.includes(c.key),
    })),
  };
}

/** The end-of-game summary, including who was paying attention. */
export async function getResults(gameId) {
  const { rows: prizes } = await query(
    `SELECT c.claim_type, p.display_name, p.wa_id
       FROM claims c JOIN players p ON p.id = c.player_id
      WHERE c.game_id = $1 AND c.status = 'awarded'
      ORDER BY c.created_at`,
    [gameId],
  );

  const { rows: accuracy } = await query(
    `SELECT p.id, p.display_name, p.wa_id,
            count(*) FILTER (WHERE a.was_correct)            AS correct,
            count(*) FILTER (WHERE a.answer = 'no_response') AS missed,
            count(*)                                          AS total
       FROM draw_answers a JOIN players p ON p.id = a.player_id
      WHERE a.game_id = $1
      GROUP BY p.id, p.display_name, p.wa_id
      ORDER BY correct DESC`,
    [gameId],
  );

  return {
    prizes: CLAIMS.map((c) => {
      const won = prizes.find((p) => p.claim_type === c.key);
      return { key: c.key, label: c.label, winner: won ? displayNameFor(won) : null };
    }),
    players: accuracy.map((r) => ({
      name: displayNameFor(r),
      correct: Number(r.correct),
      missed: Number(r.missed),
      total: Number(r.total),
    })),
  };
}
