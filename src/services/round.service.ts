import { env } from '../config/env.js';
import { getEngine } from '../core/registry.js';
import type { Entry } from '../core/types.js';
import { logger } from '../utils/logger.js';
import { activity } from '../utils/activity.js';
import { boardUrl } from '../http/board-token.js';
import {
  isFlowConfigured,
  sendCtaUrl,
  sendButtons,
  sendDocument,
  sendGameFlow,
  sendImage,
  sendList,
  sendText,
  uploadMedia,
} from '../whatsapp/client.js';
import { cancelScheduledDraw, scheduleDraw } from '../workers/queue.js';
import {
  allPlayersResponded,
  countRecentResponses,
  endGame,
  findGameById,
  listAwardedClaims,
  listDrawnNumbers,
  listEntriesForPlayer,
  listMembers,
  performDraw,
  type GameRow,
  type MemberRow,
} from './game.service.js';
import { recordGamePlayed } from './stats.service.js';
import { EVENT, track } from './analytics.service.js';
import { runWithContext } from '../utils/context.js';
import { isBoardActive } from './presence.service.js';
import { sendPromo } from './conversation.service.js';
import { buildPlayerReport } from './report.service.js';
import { buildHostReport } from './host-report.service.js';
import { notify } from './notification.service.js';
import { queryOne } from '../db/pool.js';
import { findPlayerById, publicName } from './player.service.js';

/** Encodes the game and draw a Flow reply belongs to. */
export function makeFlowToken(gameId: string, seq: number): string {
  return `${gameId}:${seq}`;
}

export function parseFlowToken(token: string): { gameId: string; seq: number } | null {
  const [gameId, seqRaw] = token.split(':');
  const seq = Number(seqRaw);
  if (!gameId || Number.isNaN(seq)) return null;
  return { gameId, seq };
}

/** Button ids carry the same correlation, since reply buttons have no token. */
export function drawButtonId(gameId: string, seq: number, has: boolean): string {
  return `ack:${gameId}:${seq}:${has ? 'y' : 'n'}`;
}

export function claimButtonId(gameId: string, claimType: string): string {
  return `claim:${gameId}:${claimType}`;
}

/* ---------------------------------------------------------------- rendering */

/**
 * Options for the Flow's dropdown.
 *
 * Exit belongs here, not only in the chat claim list: a player in Flow mode
 * never sees that list, so without this row their only way out of a running
 * game would be to type `leave` — which is exactly the dead end a button is
 * supposed to prevent.
 */
function claimOptions(game: GameRow, awarded: readonly string[]): Array<{ id: string; title: string }> {
  const engine = getEngine(game.game_key);
  const enabled = (game.config as { enabledClaims?: string[] }).enabledClaims;
  return [
    { id: 'none', title: 'Not claiming yet' },
    ...engine
      .claims()
      .filter((c) => (enabled ? enabled.includes(c.key) : true))
      .filter((c) => !awarded.includes(c.key))
      .sort((a, b) => a.order - b.order)
      .map((c) => ({ id: c.key, title: c.label })),
    { id: 'exit', title: 'Exit this game' },
  ];
}

/**
 * Strips WhatsApp chat markup from an engine's rendering — the Flow shows plain
 * text, so the monospace fence and the italic caption lines have to go.
 */
function plainBoard(rendered: string): string {
  return rendered
    .split('\n')
    .filter((line) => line !== '```' && !/^[_*]/.test(line.trim()) && !/^\w+ #\d+$/.test(line.trim()))
    .join('\n')
    .trim();
}

/* ------------------------------------------------------------- broadcasting */

/**
 * Sends one player their ticket and the current number.
 *
 * Prefers the Flow screen; falls back to a monospace ticket plus reply buttons
 * when no Flow is published, so the game is fully playable before Flows are set
 * up (and if a Flow send ever fails).
 */
async function sendDrawToPlayer(
  game: GameRow,
  member: MemberRow,
  value: number,
  seq: number,
  drawn: readonly number[],
  awarded: readonly string[],
  callText: string,
): Promise<void> {
  const engine = getEngine(game.game_key);
  const rows = await listEntriesForPlayer(game.id, member.player_id);
  if (rows.length === 0) return;

  const total = (game.state as { sequence?: unknown[] }).sequence?.length ?? 90;
  const board = boardUrl(game.id, member.player_id);

  // With a web board the ticket and every option live on the page, which
  // updates itself. Chat drops to a one-line call so the phone still buzzes,
  // with the link repeated occasionally for anyone who lost it in scrollback.
  if (board) {
    // Already looking at the board? Then the number is on their screen,
    // blinking. Sending it to chat as well is just noise.
    if (await isBoardActive(game.id, member.player_id)) return;

    const ctx = { playerId: member.player_id, gameId: game.id, drawSeq: seq };
    const remind = seq === 1 || seq % 10 === 0;

    if (remind) {
      await sendCtaUrl(member.wa_id, callText, 'Open my board', board, ctx, `${seq} of ${total} called`);
    } else {
      await sendText(member.wa_id, callText, ctx);
    }
    return;
  }

  for (const row of rows) {
    const entry: Entry = { entryNo: row.entry_no, payload: row.payload };
    const rendered = engine.renderEntry(entry as never, drawn);
    const numbers = (row.payload as { numbers?: number[] }).numbers ?? [];
    const marked = numbers.filter((n) => drawn.includes(n)).length;
    const ctx = { playerId: member.player_id, gameId: game.id, drawSeq: seq };
    const prompt = engine.ackPrompt(value);

    // Redraw the board only when this player's board actually changed, or on
    // the opening call. Roughly 15 of 90 numbers land on a given ticket, so
    // this is the difference between ~15 images per player per game and 90.
    const boardChanged = numbers.includes(value) || seq === 1;

    if (isFlowConfigured()) {
      const result = await sendGameFlow(
        member.wa_id,
        makeFlowToken(game.id, seq),
        callText,
        {
          call_label: String(value),
          progress_label: `${seq} of ${total} called · ${marked} marked on your ${engine.entryNoun}`,
          board_text: plainBoard(rendered),
          question_label: prompt.question.replace(/\*/g, ''),
          claim_options: claimOptions(game, awarded),
        },
        `Open my ${engine.entryNoun}`,
        ctx,
      );
      if (result.ok) continue;
      logger.warn({ waId: member.wa_id, error: result.error }, 'flow send failed, falling back to chat');
    }

    // Preferred: the drawn board as an image, with the call as its caption.
    if (boardChanged && engine.renderEntryImage) {
      const sent = await sendBoardImage(engine, game, member, entry, drawn, value, callText, ctx);
      if (sent) {
        await sendAckButtons(game, member, seq, prompt, ctx);
        continue;
      }
    }

    // Either the board did not change, or the image could not be produced.
    await sendText(
      member.wa_id,
      boardChanged ? `${callText}\n\n${rendered}` : `${callText}\n_Not on your ${engine.entryNoun}._`,
      ctx,
    );
    await sendAckButtons(game, member, seq, prompt, ctx);
  }
}

/** Renders and uploads the board image. Returns false if anything went wrong. */
async function sendBoardImage(
  engine: ReturnType<typeof getEngine>,
  game: GameRow,
  member: MemberRow,
  entry: Entry,
  drawn: readonly number[],
  value: number,
  caption: string,
  ctx: { playerId: string; gameId: string; drawSeq: number },
): Promise<boolean> {
  try {
    const png = await engine.renderEntryImage?.(entry as never, drawn, {
      roomCode: game.room_code,
      brand: env.BRAND_NAME,
      latest: value,
      totalNumbers: (game.state as { sequence?: unknown[] }).sequence?.length ?? 90,
    });
    if (!png) return false;

    const mediaId = await uploadMedia(png, 'image/png', `ticket-${game.room_code}-${entry.entryNo}.png`);
    if (!mediaId) return false;

    const result = await sendImage(member.wa_id, mediaId, caption, ctx);
    return result.ok;
  } catch (err) {
    // A rendering failure must never stop the game — fall through to text.
    logger.warn({ err, waId: member.wa_id }, 'board image failed, falling back to text');
    return false;
  }
}

function sendAckButtons(
  game: GameRow,
  member: MemberRow,
  seq: number,
  prompt: { question: string; yes: string; no: string },
  ctx: { playerId: string; gameId: string; drawSeq: number },
): Promise<unknown> {
  return sendButtons(
    member.wa_id,
    prompt.question,
    [
      { id: drawButtonId(game.id, seq, true), title: prompt.yes },
      { id: drawButtonId(game.id, seq, false), title: prompt.no },
      { id: `claimmenu:${game.id}`, title: 'Claim a prize' },
    ],
    ctx,
  );
}

/**
 * Draws the next number for a game and pushes it to every seated player, then
 * arms the timeout for the following number.
 */
export async function runDrawTick(gameId: string, expectedSeq: number): Promise<void> {
  // Before spending another number on the room, check anyone is still there.
  if (await isAbandoned(gameId, expectedSeq)) {
    await abandonGame(gameId, 'inactivity');
    return;
  }

  const outcome = await performDraw(gameId, expectedSeq);
  if (!outcome) return; // stale job, or game no longer running

  if (outcome.value === null) {
    await concludeGame(gameId);
    return;
  }

  const game = outcome.game;
  const engine = getEngine(game.game_key);
  const [drawn, awarded, members] = await Promise.all([
    listDrawnNumbers(game.id),
    listAwardedClaims(game.id),
    listMembers(game.id),
  ]);

  const callText = engine.renderDraw(
    { state: game.state as never, value: outcome.value, seq: outcome.seq, finished: outcome.finished },
    game.state as never,
    game.config as never,
  );

  activity(
    'game.draw',
    `room ${game.room_code} #${outcome.seq} called ${outcome.value} ` +
      `(${drawn.length}/90) → ${members.length} players`,
    { gameId: game.id, seq: outcome.seq, value: outcome.value },
  );

  const fanOutStartedAt = Date.now();

  await track({
    type: EVENT.GAME_DRAW,
    source: 'worker',
    gameId: game.id,
    properties: {
      seq: outcome.seq,
      value: outcome.value,
      recipients: members.length,
      drawnSoFar: drawn.length,
      prizesGone: awarded.length,
    },
  });

  // Sequential rather than parallel: keeps us inside the Cloud API's
  // per-second throughput and preserves a sane ordering per recipient.
  for (const member of members) {
    try {
      await runWithContext({ playerId: member.player_id, gameId: game.id, drawSeq: outcome.seq }, () =>
        sendDrawToPlayer(game, member, outcome.value as number, outcome.seq, drawn, awarded, callText),
      );
    } catch (err) {
      logger.error({ err, waId: member.wa_id }, 'failed to deliver draw');
    }
  }

  logger.debug({ gameId, seq: outcome.seq, fanOutMs: Date.now() - fanOutStartedAt }, 'draw fanned out');

  if (outcome.finished) {
    await concludeGame(gameId);
    return;
  }

  await scheduleDraw(gameId, outcome.seq, env.DRAW_INTERVAL_SECONDS * 1000);
}

/**
 * True when the room has gone quiet: enough numbers have been called for the
 * check to mean something, and not one player answered any of them.
 *
 * The stalled-game sweeper cannot catch this case, because it watches the time
 * of the last draw — and draws keep firing on the timer whether or not anyone
 * is listening.
 */
async function isAbandoned(gameId: string, currentSeq: number): Promise<boolean> {
  const window = env.GAME_INACTIVITY_DRAWS;
  if (currentSeq < window) return false;

  const responses = await countRecentResponses(gameId, currentSeq, window);
  return responses === 0;
}

/** Ends a game nobody is playing, and tells whoever is still nominally in it. */
export async function abandonGame(gameId: string, reason: 'inactivity' | 'empty'): Promise<void> {
  const game = await findGameById(gameId);
  if (!game || game.status !== 'running') return;

  const members = await listMembers(gameId);
  await endGame(gameId, 'cancelled');
  await cancelScheduledDraw(gameId, Number((game.state as { cursor?: number }).cursor ?? 0));

  await track({
    type: EVENT.GAME_ABANDONED,
    source: 'worker',
    gameId,
    properties: { roomCode: game.room_code, reason, members: members.length },
  });

  const text =
    reason === 'inactivity'
      ? [
          `⏹️ Room *${game.room_code}* has been closed.`,
          '',
          `Nobody answered the last ${env.GAME_INACTIVITY_DRAWS} numbers, so the game was stopped.`,
          'Send *play* to start a fresh round.',
        ].join('\n')
      : `⏹️ Room *${game.room_code}* was closed because everyone left.`;

  for (const member of members) {
    try {
      await runWithContext({ playerId: member.player_id, gameId }, () => sendText(member.wa_id, text));
    } catch (err) {
      logger.warn({ err, waId: member.wa_id }, 'failed to deliver abandonment notice');
    }
  }
}

/**
 * Called after each acknowledgement. Once everyone has answered we cut the
 * remaining wait short and move to the next number.
 */
export async function maybeAdvanceEarly(gameId: string, seq: number): Promise<void> {
  if (!(await allPlayersResponded(gameId, seq))) return;

  await track({
    type: EVENT.GAME_TICK_EARLY_ADVANCE,
    source: 'whatsapp',
    gameId,
    properties: { seq },
  });

  await cancelScheduledDraw(gameId, seq);

  // A short beat rather than zero: the last tap and the next number arriving
  // together looks like a glitch, and nobody sees "everyone has answered".
  await scheduleDraw(gameId, seq, env.EARLY_ADVANCE_DELAY_MS);
}

/* --------------------------------------------------------------- conclusion */

export async function concludeGame(gameId: string): Promise<void> {
  const game = await findGameById(gameId);
  if (!game) return;

  await endGame(gameId, 'completed');

  const [members, awarded] = await Promise.all([listMembers(gameId), listAwardedClaims(gameId)]);
  const engine = getEngine(game.game_key);
  const labels = new Map(engine.claims().map((c) => [c.key, c.label]));

  const summary =
    awarded.length > 0
      ? awarded.map((key) => `• ${labels.get(key) ?? key}`).join('\n')
      : '_No prizes were claimed._';

  const text = [
    '🎉 *Game over!*',
    `Room *${game.room_code}*`,
    '',
    '*Prizes won*',
    summary,
    '',
    'Send *stats* for your record, or *play* to start another round.',
  ].join('\n');

  const drawn = await listDrawnNumbers(gameId);

  await track({
    type: EVENT.GAME_COMPLETED,
    source: 'worker',
    gameId,
    properties: {
      roomCode: game.room_code,
      gameKey: game.game_key,
      players: members.length,
      numbersDrawn: drawn.length,
      prizesAwarded: awarded,
      // Wall-clock length of the round, for the "how long is a game" metric.
      durationMs: game.started_at ? Date.now() - new Date(game.started_at).getTime() : null,
    },
  });

  const winner = awarded.includes('full_house')
    ? (await queryOne<{ display_name: string | null; player_id: string }>(
        `SELECT c.player_id, p.display_name FROM game_claims c JOIN players p ON p.id = c.player_id
          WHERE c.game_id = $1 AND c.claim_type = 'full_house' AND c.status = 'awarded' LIMIT 1`,
        [gameId],
      ))
    : null;

  void notify({
    trigger: 'game.ended',
    summary:
      `Room ${game.room_code} finished — ${members.length} players, ${drawn.length} numbers, ` +
      `${awarded.length} prizes${winner ? `, won by ${publicName(winner.player_id, winner.display_name)}` : ', no full house'}`,
    gameId,
    detail: {
      roomCode: game.room_code,
      players: members.length,
      numbersCalled: drawn.length,
      prizes: awarded,
      durationMinutes: game.started_at
        ? Math.round((Date.now() - new Date(game.started_at).getTime()) / 60000)
        : null,
    },
  });

  for (const member of members) {
    try {
      await recordGamePlayed(member.player_id);
      await runWithContext({ playerId: member.player_id, gameId }, () => sendText(member.wa_id, text));
    } catch (err) {
      logger.error({ err, waId: member.wa_id }, 'failed to deliver game summary');
    }
  }

  // One question, asked once, while the game is still fresh.
  //
  // Asked here rather than in a follow-up campaign because this is the only
  // moment a player is certain to be looking at the chat, and a rating loses
  // its meaning an hour later. Three taps, no typing — anyone who wants to say
  // more can, but nobody has to.
  for (const member of members) {
    try {
      await runWithContext({ playerId: member.player_id, gameId }, () =>
        sendButtons(
          member.wa_id,
          'How was that game?',
          [
            { id: `rate:${gameId}:5`, title: '😀 Great' },
            { id: `rate:${gameId}:3`, title: '🙂 Fine' },
            { id: `rate:${gameId}:1`, title: '😕 Not good' },
          ],
        ),
      );
    } catch (err) {
      logger.debug({ err, waId: member.wa_id }, 'could not ask for feedback');
    }
  }

  // The report goes to everybody who played, winner or not — the loser's copy
  // is the one that says who won. Sent after the summary so the short message
  // lands first and the PDF arrives under it, and sequentially rather than in
  // parallel so a room of thirty does not open thirty uploads at once.
  for (const member of members) {
    await sendGameReport(member.player_id, member.wa_id, gameId);
  }

  // The host gets one more, about the room rather than their ticket.
  const host = members.find((m) => m.player_id === game.host_player_id);
  if (host) await sendHostReport(host.player_id, host.wa_id, gameId);
}

/**
 * Builds and sends one player's end-of-game report.
 *
 * Rendered per player rather than once for the room: the banner congratulates
 * the winner and tells everyone else who won, so the file genuinely differs.
 */
async function sendGameReport(playerId: string, waId: string, gameId: string): Promise<void> {
  try {
    const player = await findPlayerById(playerId);
    if (!player) return;

    const { buffer, filename } = await buildPlayerReport(player, gameId);
    const mediaId = await uploadMedia(buffer, 'application/pdf', filename);
    if (!mediaId) return;

    await sendDocument(waId, mediaId, filename, 'Your game report and full playing history.', {
      playerId,
      gameId,
    });
  } catch (err) {
    // A report is a nice-to-have; never let it break the end of a game.
    logger.warn({ err, playerId }, 'could not send end-of-game report');
  }
}

/**
 * Sends the host their report on the room.
 *
 * A second document, not a replacement: the host played too, so they get the
 * player report like everybody else, and this one on top. They are two
 * different questions — "how did I do" and "how did my room do" — and answering
 * both in one PDF buried the second half under the first.
 */
async function sendHostReport(hostPlayerId: string, waId: string, gameId: string): Promise<void> {
  try {
    const report = await buildHostReport(hostPlayerId, waId, gameId);
    if (!report) return;

    const mediaId = await uploadMedia(report.buffer, 'application/pdf', report.filename);
    if (!mediaId) return;

    await sendDocument(
      waId,
      mediaId,
      report.filename,
      'Your host report: who joined, who stayed, and how the room went.',
      { playerId: hostPlayerId, gameId },
    );
  } catch (err) {
    logger.warn({ err, hostPlayerId, gameId }, 'could not send host report');
  }
}
