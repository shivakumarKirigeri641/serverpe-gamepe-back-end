import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { getEngine } from '../core/registry.js';
import { logger } from '../utils/logger.js';
import { redis } from '../redis/client.js';
import { EVENT, track } from '../services/analytics.service.js';
import {
  GameError,
  findGameById,
  listAwardedClaims,
  listDrawnNumbers,
  listEntriesForPlayer,
  listMembers,
} from '../services/game.service.js';
import { displayNameOf, findPlayerById } from '../services/player.service.js';
import { handleAck, handleClaim, handleLeave, handleStart } from '../services/conversation.service.js';
import { nicknameFor } from '../games/tambola/nicknames.js';
import { renderBoardPage } from './board-page.js';
import { inviteUrl, verifyBoardToken } from './board-token.js';
import { clientIp } from './admin-auth.js';
import { markBoardActive } from '../services/presence.service.js';
import { queryOne, query } from '../db/pool.js';

/**
 * The player-facing web board.
 *
 * Public by URL but not guessable: every route verifies the HMAC in the token
 * and derives the player from it, so a link can only ever show its own owner's
 * ticket and can only act on their behalf.
 */

interface Resolved {
  gameId: string;
  playerId: string;
}

function resolve(req: Request, res: Response): Resolved | null {
  const payload = verifyBoardToken(String(req.params['token'] ?? ''));
  if (!payload) {
    res.status(403).json({ error: 'This link is not valid.' });
    return null;
  }
  return payload;
}

/** Modest per-token limit: a polling page is chatty, a script should not be. */
async function withinRateLimit(token: string, action: string, max: number, seconds: number): Promise<boolean> {
  const key = `ratelimit:board:${action}:${token.slice(0, 32)}:${Math.floor(Date.now() / (seconds * 1000))}`;
  try {
    const hits = await redis.incr(key);
    if (hits === 1) await redis.expire(key, seconds);
    return hits <= max;
  } catch {
    return true; // never lock a player out of their game over a Redis blip
  }
}

export function createBoardRouter(): Router {
  const router = Router();

  /* ------------------------------------------------------------ the page */

  router.get('/:token', async (req: Request, res: Response) => {
    const payload = verifyBoardToken(String(req.params['token'] ?? ''));
    if (!payload) {
      res.status(403).type('html').send('<h1>This link is not valid.</h1>');
      return;
    }

    // The one place we genuinely see a player's device: this is a real browser.
    await track({
      type: EVENT.BOARD_OPENED,
      source: 'web',
      gameId: payload.gameId,
      playerId: payload.playerId,
      requestIp: clientIp(req),
      userAgent: req.header('user-agent') ?? null,
      properties: { referer: req.header('referer') ?? null },
    });

    res
      .status(200)
      .type('html')
      .set('Cache-Control', 'no-store')
      .send(renderBoardPage(String(req.params['token'])));
  });

  /* ----------------------------------------------------------- the state */

  router.get('/:token/state', async (req: Request, res: Response) => {
    const payload = resolve(req, res);
    if (!payload) return;

    if (!(await withinRateLimit(String(req.params['token']), 'state', 60, 60))) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }

    // Polling is the heartbeat: it tells the draw loop this player is watching
    // and does not need a chat notification for every number.
    await markBoardActive(payload.gameId, payload.playerId);

    try {
      const state = await buildState(payload.gameId, payload.playerId);
      if (!state) {
        res.status(404).json({ error: 'Game not found' });
        return;
      }
      res.set('Cache-Control', 'no-store').json({ data: state });
    } catch (err) {
      logger.error({ err }, 'board state failed');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  /* --------------------------------------------------------- the actions */

  router.post('/:token/ack', async (req: Request, res: Response) => {
    const payload = resolve(req, res);
    if (!payload) return;

    const body = z.object({ hasNumber: z.boolean() }).safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    const player = await findPlayerById(payload.playerId);
    const drawn = await listDrawnNumbers(payload.gameId);
    if (!player || drawn.length === 0) {
      res.json({ ok: false });
      return;
    }

    await handleAck(player, payload.gameId, drawn.length, body.data.hasNumber);
    res.json({ ok: true });
  });

  router.post('/:token/claim', async (req: Request, res: Response) => {
    const payload = resolve(req, res);
    if (!payload) return;

    if (!(await withinRateLimit(String(req.params['token']), 'claim', 10, 60))) {
      res.status(429).json({ error: 'Too many claims. Slow down.' });
      return;
    }

    const body = z.object({ claimType: z.string().min(1).max(64) }).safeParse(req.body ?? {});
    const player = await findPlayerById(payload.playerId);
    if (!body.success || !player) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    try {
      // Same path as a claim from chat, so validation and announcements are
      // identical whichever surface the player used.
      await handleClaim(player, payload.gameId, body.data.claimType);
      res.json({ ok: true });
    } catch (err) {
      res.json({ ok: false, message: err instanceof GameError ? err.message : 'Could not claim.' });
    }
  });

  router.post('/:token/start', async (req: Request, res: Response) => {
    const payload = resolve(req, res);
    if (!payload) return;

    const player = await findPlayerById(payload.playerId);
    if (!player) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    try {
      // Same guard as the chat button: only the host may start, and only once
      // enough players are in.
      await handleStart(player, payload.gameId);
      res.json({ ok: true });
    } catch (err) {
      res.json({ ok: false, message: err instanceof GameError ? err.message : 'Could not start the game.' });
    }
  });

  router.post('/:token/exit', async (req: Request, res: Response) => {
    const payload = resolve(req, res);
    if (!payload) return;

    const player = await findPlayerById(payload.playerId);
    if (!player) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    await handleLeave(player, payload.gameId);
    res.json({ ok: true, message: 'You have left the game.' });
  });

  return router;
}

/* ------------------------------------------------------------------ state */

/**
 * Everything the page needs, in one response.
 *
 * Currently shaped around Tambola's 3x9 grid. A second game with a different
 * board will need its own builder selected by `game_key` — the same split the
 * engine interface already makes for chat rendering.
 */
async function buildState(gameId: string, playerId: string): Promise<Record<string, unknown> | null> {
  const game = await findGameById(gameId);
  if (!game) return null;

  const [player, entries, drawn, awarded, members] = await Promise.all([
    findPlayerById(playerId),
    listEntriesForPlayer(gameId, playerId),
    listDrawnNumbers(gameId),
    listAwardedClaims(gameId),
    listMembers(gameId),
  ]);

  const entry = entries[0];
  if (!player || !entry) return null;

  const payload = entry.payload as { grid: (number | null)[][]; numbers: number[] };
  const engine = getEngine(game.game_key);
  const currentNumber = drawn.length > 0 ? (drawn[drawn.length - 1] as number) : null;

  const answered = await queryOne<{ has_number: boolean }>(
    'SELECT has_number FROM game_draw_responses WHERE game_id = $1 AND seq = $2 AND player_id = $3',
    [gameId, drawn.length, playerId],
  );

  // How many of the room have answered the number in play. Shown back to the
  // player after they tap, so the wait has a visible reason rather than
  // looking like nothing happened.
  const answeredRow = await queryOne<{ count: string }>(
    'SELECT count(*)::text AS count FROM game_draw_responses WHERE game_id = $1 AND seq = $2',
    [gameId, drawn.length],
  );

  // Winner names for prizes already gone.
  const winners = await query<{ claim_type: string; display_name: string | null; wa_id: string }>(
    `SELECT c.claim_type, p.display_name, p.wa_id
       FROM game_claims c JOIN players p ON p.id = c.player_id
      WHERE c.game_id = $1 AND c.status = 'awarded'`,
    [gameId],
  );
  const winnerBy = new Map(
    winners.map((w) => [w.claim_type, w.display_name?.trim() || `Player ••${w.wa_id.slice(-4)}`]),
  );

  const enabled = (game.config as { enabledClaims?: string[] }).enabledClaims;
  const prizes = engine
    .claims()
    .filter((c) => (enabled ? enabled.includes(c.key) : true))
    .sort((a, b) => a.order - b.order)
    .map((c) => ({ key: c.key, label: c.label, wonBy: winnerBy.get(c.key) ?? null }));

  const myWins = winners.filter((w) => winnerBy.get(w.claim_type) === displayNameOf(player));

  const minPlayers = Math.max(engine.minPlayers, env.MIN_PLAYERS_TO_START);

  return {
    brand: env.BRAND_NAME,
    roomCode: game.room_code,
    status: game.status,
    isHost: game.host_player_id === playerId,
    playersJoined: members.length,
    expectedPlayers: game.expected_players,
    minPlayers,
    canStart: members.length >= minPlayers,
    inviteUrl: inviteUrl(game.room_code),
    playerNames: members.map((m) => m.display_name?.trim() || `Player ••${m.wa_id.slice(-4)}`),
    entryNo: entry.entry_no,
    playerName: displayNameOf(player),
    players: members.length,
    grid: payload.grid,
    myNumbers: payload.numbers,
    // Everything called EXCEPT the number in play, until the player has
    // answered for it. Marking it immediately would answer the question for
    // them, which is the whole game.
    called: answered ? drawn : drawn.slice(0, -1),
    markedCount: payload.numbers.filter((n) => (answered ? drawn : drawn.slice(0, -1)).includes(n)).length,
    currentNumber,
    currentNickname: currentNumber ? (nicknameFor(currentNumber) ?? '') : '',
    currentSeq: drawn.length,
    totalNumbers: (game.state as { sequence?: unknown[] }).sequence?.length ?? 90,
    answered: Boolean(answered),
    myAnswer: answered ? answered.has_number : null,
    answeredCount: Number(answeredRow?.count ?? 0),
    waitingFor: Math.max(members.length - Number(answeredRow?.count ?? 0), 0),
    drawIntervalSeconds: env.DRAW_INTERVAL_SECONDS,
    prizes,
    iWon: myWins.length > 0,
    awardedCount: awarded.length,
  };
}
