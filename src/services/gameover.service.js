/**
 * What happens after the last number.
 *
 * When a game ends every player gets a WhatsApp message with how they did, a
 * link to their full report, and a prompt to rate the game. This is the only
 * moment the platform messages a player who did not just message us, and it is
 * squarely inside the 24-hour window because they were playing seconds ago.
 *
 * Everything here is best-effort and runs after the game is already recorded
 * as finished. A failure to send a summary must never leave a game in limbo.
 */
import { query } from '../db/pool.js';
import { log } from '../utils/logger.js';
import { config } from '../config/env.js';
import { signBoardToken, feedbackUrl } from '../utils/code.js';
import { sendText, sendCtaUrl } from '../whatsapp/client.js';
import { displayNameFor, setState } from './player.service.js';
import { getResults } from './claim.service.js';
import { recordEvent } from './tracking.service.js';
import { notify } from './notification.service.js';
import { STATES } from './conversation-states.js';
import { CLAIMS } from '../games/tambola/claims.js';
import { copy } from './copy.js';

export const FEEDBACK_BUTTONS = {
  RATE_5: 'rate_5',
  RATE_3: 'rate_3',
  RATE_1: 'rate_1',
};

/** The report URL is signed per player, exactly like the board. */
export function reportUrl(gameId, playerId) {
  return `${config.publicRoot}/report/${signBoardToken(gameId, playerId)}`;
}

/**
 * Fans the end-of-game summary out to everyone who was seated.
 *
 * Called once, from wherever the game was marked finished. Guarded by an
 * event marker so a replayed call cannot message everybody twice.
 */
export async function announceGameOver(gameId) {
  const already = await query(
    `SELECT 1 FROM analytics_events
      WHERE game_id = $1 AND event_type = 'game.summary_sent' LIMIT 1`,
    [gameId],
  );
  if (already.rows.length) {
    log.debug('summary already sent', { gameId });
    return { sent: 0, skipped: true };
  }

  const { rows: games } = await query('SELECT * FROM games WHERE id = $1', [gameId]);
  const game = games[0];
  if (!game || game.status !== 'finished') return { sent: 0 };

  const results = await getResults(gameId);

  const { rows: players } = await query(
    `SELECT p.id, p.wa_id, p.display_name, gp.is_host
       FROM game_players gp JOIN players p ON p.id = gp.player_id
      WHERE gp.game_id = $1 AND gp.left_at IS NULL`,
    [gameId],
  );

  // Marked before sending. If the process dies halfway, the survivors have
  // already had their message and nobody gets it twice on restart.
  await recordEvent({
    type: 'game.summary_sent', source: 'system', gameId,
    properties: { players: players.length },
  });

  const champion = results.prizes.find((p) => p.key === 'full_house');
  notify('game.ended', {
    title: `Game ${game.code} ended`,
    lines: [
      `Room: ${game.code}`,
      `Reason: ${(game.ended_reason || 'unknown').replace(/_/g, ' ')}`,
      `Players: ${players.length}`,
      `Numbers called: ${game.cursor} of 90`,
      `Full House: ${champion?.winner ?? 'nobody'}`,
      `Prizes won: ${results.prizes.filter((p) => p.winner).length} of 6`,
    ],
    gameId: game.id,
  });

  let sent = 0;
  for (const player of players) {
    try {
      const name = displayNameFor(player);
      const mine = results.players.find((r) => r.name === name);
      const won = results.prizes.filter((p) => p.winner === name);

      await sendText(player.wa_id, summaryText({ game, results, mine, won, name }));
      await sendText(player.wa_id, copy.gameReport(game.code, reportUrl(game.id, player.id)));

      // One tap to a proper form, rather than three buttons and a follow-up.
      //
      // The old flow asked for a star on WhatsApp and then hoped for a comment
      // in a second message - which meant the rating and the words arrived
      // separately, and most people stopped after the star. A form collects
      // both in one go, gives room to actually write something, and is the
      // only version that produces text worth publishing as a testimonial.
      await sendCtaUrl(
        player.wa_id,
        `How was that game? Your rating helps us make it better - and the nice ` +
          `ones may appear on our site.`,
        {
          displayText: 'Provide Feedback',
          url: feedbackUrl(player.id, gameId),
          footer: 'Takes about twenty seconds',
        },
      );

      // Back to the menu, not parked in a feedback state. The rating is being
      // given in the browser now, so treating their next WhatsApp message as a
      // comment would swallow a perfectly ordinary "hi".
      await setState(player.id, STATES.MENU, {});
      sent++;
    } catch (err) {
      log.warn('could not send game summary', { playerId: player.id, message: err.message });
    }
  }

  log.info('game summaries sent', { gameId, sent, of: players.length });
  return { sent };
}

/**
 * Tells the remaining players a game was abandoned.
 *
 * Deliberately NOT the celebration path: nobody won, so there is no trophy, no
 * confetti and no "congratulations". It says what happened, that it was not
 * their fault, and what to do next — and it still links the report, because
 * the numbers that were called are a matter of record either way.
 */
export async function announceGameAbandoned(gameId, { leaverName = null } = {}) {
  const already = await query(
    `SELECT 1 FROM analytics_events
      WHERE game_id = $1 AND event_type = 'game.abandoned_sent' LIMIT 1`,
    [gameId],
  );
  if (already.rows.length) return { sent: 0, skipped: true };

  const { rows: games } = await query('SELECT * FROM games WHERE id = $1', [gameId]);
  const game = games[0];
  if (!game) return { sent: 0 };

  const { rows: players } = await query(
    `SELECT p.id, p.wa_id, p.display_name
       FROM game_players gp JOIN players p ON p.id = gp.player_id
      WHERE gp.game_id = $1 AND gp.left_at IS NULL`,
    [gameId],
  );

  notify('game.abandoned', {
    title: `Game ${game.code} was abandoned`,
    lines: [
      `Room: ${game.code}`,
      leaverName ? `${leaverName} left` : 'Too few players remained',
      `${players.length} player(s) were still in it`,
      `${game.cursor} numbers had been called`,
    ],
    gameId,
  });
  await recordEvent({
    type: 'game.abandoned_sent', source: 'system', gameId,
    properties: { remaining: players.length, leaver: leaverName },
  });

  let sent = 0;
  for (const player of players) {
    try {
      await sendText(player.wa_id, abandonedText({ game, leaverName }));
      await sendText(player.wa_id, copy.gameReport(game.code, reportUrl(game.id, player.id)));
      await setState(player.id, STATES.MENU, {});
      sent++;
    } catch (err) {
      log.warn('could not send abandon notice', { playerId: player.id, message: err.message });
    }
  }

  log.info('game abandoned, players told', { gameId, sent });
  return { sent };
}

function abandonedText({ game, leaverName }) {
  return [
    `*Game ${game.code} has ended early*`,
    '',
    leaverName
      ? `${leaverName} left the game, which left too few players to carry on.`
      : `Too few players were left to carry on.`,
    '',
    `Tambola needs at least two players, so we have stopped the game rather ` +
      `than keep calling numbers. No prizes have been awarded.`,
    '',
    `${game.cursor} number${game.cursor === 1 ? '' : 's'} were called before it ended — ` +
      `the full record is in the link below.`,
    '',
    `Thank you for playing. Message *hi* whenever you would like another game.`,
  ].join('\n');
}

function summaryText({ game, results, mine, won, name }) {
  const lines = [];
  lines.push(`*Game ${game.code} - that's a wrap!* 🎉`, '');

  const champion = results.prizes.find((p) => p.key === 'full_house');
  if (champion?.winner) {
    lines.push(
      champion.winner === name
        ? `🏆 *You won the Full House!* Every number on your ticket was called.`
        : `🏆 *${champion.winner}* took the Full House.`,
      '',
    );
  }

  lines.push('*Prizes*');
  for (const prize of results.prizes) {
    const label = CLAIMS.find((c) => c.key === prize.key)?.label ?? prize.key;
    if (!prize.winner) lines.push(`• ${label} — _unclaimed_`);
    else if (prize.winner === name) lines.push(`• ${label} — *you* 🎉`);
    else lines.push(`• ${label} — ${prize.winner}`);
  }

  if (mine) {
    // Accuracy over decisions, not over all 90. Counting numbers nobody
    // answered as errors punished a player whose signal dropped.
    const pct = mine.answered ? Math.round((mine.correct / mine.answered) * 100) : 0;
    lines.push(
      '',
      '*How you played*',
      `• Marked correctly: ${mine.correct} of ${mine.answered} answered (${pct}%)`,
    );
    // Each line only when it happened - a clean sheet should read as a clean
    // sheet, not as a list of zeroes.
    if (mine.missed)     lines.push(`• On your ticket but said no: ${mine.missed}`);
    if (mine.wrongTaps)  lines.push(`• Marked but not on your ticket: ${mine.wrongTaps}`);
    if (mine.noResponse) lines.push(`• Never answered: ${mine.noResponse}`);
    lines.push(`• Prizes won: ${won.length}`);
  }

  lines.push('', 'Your full report, ticket and every number is in the link below.');
  return lines.join('\n');
}

/** Everything the per-player report page shows. */
export async function playerReport(gameId, playerId) {
  const { rows: games } = await query('SELECT * FROM games WHERE id = $1', [gameId]);
  const game = games[0];
  if (!game) return null;

  const { rows: people } = await query(
    `SELECT p.id, p.wa_id, p.display_name, gp.is_host, gp.joined_at, gp.left_at
       FROM game_players gp JOIN players p ON p.id = gp.player_id
      WHERE gp.game_id = $1 AND gp.player_id = $2`,
    [gameId, playerId],
  );
  if (!people[0]) return null;

  const { rows: entry } = await query(
    'SELECT ticket FROM entries WHERE game_id = $1 AND player_id = $2',
    [gameId, playerId],
  );

  // Every number, with what this player did about it. This is the row-by-row
  // audit an operator or a suspicious player can check a disputed game against.
  const { rows: timeline } = await query(
    `SELECT d.seq, d.value, d.drawn_at,
            a.answer, a.was_correct, a.answered_at,
            EXTRACT(EPOCH FROM (a.answered_at - d.drawn_at)) AS took_seconds
       FROM draws d
       LEFT JOIN draw_answers a
              ON a.game_id = d.game_id AND a.seq = d.seq AND a.player_id = $2
      WHERE d.game_id = $1
      ORDER BY d.seq`,
    [gameId, playerId],
  );

  const { rows: claims } = await query(
    `SELECT claim_type, status, seq, reason, created_at
       FROM claims WHERE game_id = $1 AND player_id = $2 ORDER BY created_at`,
    [gameId, playerId],
  );

  const host = await query(
    `SELECT p.wa_id, p.display_name FROM players p WHERE p.id = $1`,
    [game.host_player_id],
  );

  const results = await getResults(gameId);
  const me = displayNameFor(people[0]);

  return {
    game: {
      code: game.code,
      status: game.status,
      startedAt: game.started_at,
      endedAt: game.ended_at,
      endedReason: game.ended_reason,
      numbersCalled: game.cursor,
      expectedPlayers: game.expected_players,
      drawInterval: game.draw_interval_seconds,
    },
    host: host.rows[0] ? displayNameFor(host.rows[0]) : null,
    you: {
      name: me,
      isHost: people[0].is_host,
      joinedAt: people[0].joined_at,
      // Set if they walked out before the end. The report still shows every
      // number that was called - what changes is that the numbers after this
      // moment were never theirs to mark, and the page says so rather than
      // letting the accuracy figure quietly imply they stopped paying attention.
      leftAt: people[0].left_at,
    },
    ticket: entry[0]?.ticket ?? null,
    timeline: timeline.map((t) => ({
      seq: t.seq,
      value: t.value,
      drawnAt: t.drawn_at,
      answer: t.answer ?? 'no_response',
      wasCorrect: t.was_correct,
      tookSeconds: t.took_seconds === null ? null : Math.max(0, Number(t.took_seconds)),
    })),
    claims,
    prizes: results.prizes,
    accuracy: results.players.find((p) => p.name === me) ?? null,
    leaderboard: results.players,
    brand: config.brandName,
  };
}
