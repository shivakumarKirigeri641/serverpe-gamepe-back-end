/**
 * The board: the page a player actually plays on, and the endpoints behind it.
 *
 * Every route is addressed by a signed token that names one player in one
 * game, so possessing the room code is never enough to see somebody else's
 * ticket.
 */
import { Router } from 'express';
import { log } from '../utils/logger.js';
import { config } from '../config/env.js';
import { verifyBoardToken, inviteUrl } from '../utils/code.js';
import { boardPage } from './board-page.js';
import { reportPage } from './report-page.js';
import { playerReport } from '../services/gameover.service.js';
import {
  getGameById, getLobby, getEntry, isPlayerInGame, startGame, GameError,
} from '../services/game.service.js';
import { getPlayerById, displayNameFor } from '../services/player.service.js';
import { getDraws, getAnswers, recordAnswer, answerProgress } from '../services/round.service.js';
import { attemptClaim, getClaimState, getResults } from '../services/claim.service.js';
import { subscribe, sendTo, broadcast } from '../services/live.service.js';
import { taglineFor } from '../games/tambola/taglines.js';
import { trackBoardRequest, recordEvent } from '../services/tracking.service.js';
import { notify } from '../services/notification.service.js';

/**
 * Express 4 does not catch rejections from async handlers - they escape as
 * unhandled rejections and take the process down with them. Every async route
 * below goes through this, so a bad request can only ever produce a 500.
 */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function boardRoutes() {
  const router = Router();

  /** Turns the token into a verified (game, player) pair, or 403s. */
  const resolve = wrap(async function resolve(req, res, next) {
    const ids = verifyBoardToken(req.params.token);
    if (!ids) {
      return res.status(403).json({ error: 'This link is not valid. Ask your host for a new one.' });
    }
    const [game, player] = await Promise.all([
      getGameById(ids.gameId),
      getPlayerById(ids.playerId),
    ]);
    if (!game || !player) return res.status(404).json({ error: 'That game no longer exists.' });
    if (!(await isPlayerInGame(game.id, player.id))) {
      return res.status(403).json({ error: 'You are not in this game.' });
    }
    req.game = game;
    req.player = player;
    next();
  });

  // The page itself carries no game data - it fetches its own state, so a
  // reload or a reconnect always goes through the same path.
  router.get('/board/:token', (req, res) => {
    if (!verifyBoardToken(req.params.token)) {
      return res.status(403).type('html').send(errorPage('This link is not valid.', 'Ask your host to send you a fresh one.'));
    }
    res.type('html').send(boardPage());
  });

  router.get('/board/:token/state', resolve, wrap(async (req, res) => {
    // Every state fetch is a page open or a reconnect, so this is the most
    // reliable place to keep the session and the player's device columns fresh.
    await trackBoardRequest(req, {
      gameId: req.game.id, playerId: req.player.id, type: 'board.opened',
      properties: { status: req.game.status },
    });
    res.json(await snapshot(req.game.id, req.player.id));
  }));

  /**
   * The live feed. Sends the full state immediately so the client never has
   * to combine a fetch with a stream, then streams changes.
   */
  router.get('/board/:token/stream', resolve, wrap(async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx and similar proxies buffer by default, which would hold events
      // back until the buffer fills - fatal for a live game.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    // Counted separately from board_open: a rising stream_opens count on one
    // session is the signature of a connection that keeps dropping, which is
    // exactly what the WhatsApp in-app browser does when backgrounded.
    await trackBoardRequest(req, {
      gameId: req.game.id, playerId: req.player.id, type: 'board.reconnected', isStreamOpen: true,
    });

    subscribe(req.game.id, res);
    sendTo(res, 'state', await snapshot(req.game.id, req.player.id));
  }));

  router.post('/board/:token/start', resolve, wrap(async (req, res) => {
    try {
      const game = await startGame({ gameId: req.game.id, playerId: req.player.id });
      // The countdown every board shows IS the schedule: next_draw_at is set
      // this many seconds out, so the number lands as the counter hits zero.
      broadcast(game.id, 'started', {
        countdownSeconds: config.game.startCountdownSeconds,
        drawInterval: game.draw_interval_seconds,
      });
      notify('game.started', {
        title: `Game ${game.code} started`,
        lines: [
          `Room: ${game.code}`,
          `Expected ${game.expected_players} players`,
        ],
        playerId: req.player.id, gameId: game.id,
      });
      await recordEvent({
        type: 'game.started', source: 'board', req,
        playerId: req.player.id, gameId: game.id,
        properties: { expectedPlayers: game.expected_players },
      });
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof GameError) return res.status(400).json({ error: err.message });
      throw err;
    }
  }));

  router.post('/board/:token/answer', resolve, wrap(async (req, res) => {
    const seq = Number(req.body?.seq);
    const answer = String(req.body?.answer ?? '');
    if (!Number.isInteger(seq)) return res.status(400).json({ error: 'seq is required' });

    const result = await recordAnswer({
      gameId: req.game.id, playerId: req.player.id, seq, answer,
    });
    if (!result.ok) return res.status(400).json({ error: result.reason });

    // `audit` holds whether they were right. It goes to the event log and
    // nowhere near the response - players find out when the game ends.
    const { audit, ...forPlayer } = result;

    await recordEvent({
      type: 'game.ack', source: 'board', req,
      playerId: req.player.id, gameId: req.game.id,
      properties: {
        seq, value: result.value, answer: result.answer,
        onTicket: audit.onTicket, wasCorrect: audit.wasCorrect,
        duplicate: result.alreadyAnswered,
      },
    });
    res.json(forPlayer);
  }));

  /**
   * The per-player report, on the same signed token as the board. Readable
   * long after the game - it is the link WhatsApp sends when a game ends.
   */
  router.get('/report/:token', wrap(async (req, res) => {
    const ids = verifyBoardToken(req.params.token);
    if (!ids) {
      return res.status(403).type('html')
        .send(errorPage('This report link is not valid.', 'Ask your host to send it again.'));
    }
    const report = await playerReport(ids.gameId, ids.playerId);
    if (!report) {
      return res.status(404).type('html')
        .send(errorPage('That report no longer exists.', 'The game may have been cleared.'));
    }
    await recordEvent({
      type: 'report.opened', source: 'board', req,
      playerId: ids.playerId, gameId: ids.gameId,
    });
    res.type('html').send(reportPage(report));
  }));

  router.post('/board/:token/claim', resolve, wrap(async (req, res) => {
    const claimType = String(req.body?.claimType ?? '');
    const result = await attemptClaim({
      gameId: req.game.id, playerId: req.player.id, claimType,
    });
    log.info('claim attempt', {
      gameId: req.game.id, playerId: req.player.id, claimType, ok: result.ok,
    });
    await recordEvent({
      type: result.ok ? 'claim.awarded' : 'claim.rejected', source: 'board', req,
      playerId: req.player.id, gameId: req.game.id,
      properties: { claimType, reason: result.reason ?? null },
    });
    res.json(result);
  }));

  return router;
}

/**
 * One object describing everything the board needs to render from scratch.
 * Deliberately complete: a reconnecting browser replaces its whole state
 * rather than trying to patch up what it thinks it missed.
 */
async function snapshot(gameId, playerId) {
  const [lobby, ticket, draws, answers, claims] = await Promise.all([
    getLobby(gameId),
    getEntry(gameId, playerId),
    getDraws(gameId),
    getAnswers(gameId, playerId),
    getClaimState(gameId, playerId),
  ]);

  const game = lobby.game;
  const latest = draws[draws.length - 1] ?? null;

  // The player's own marks: the numbers they said yes to. Their taps drive
  // this, not the draw - claims are validated separately against `draws`.
  const marked = answers.filter((a) => a.answer === 'yes').map((a) => a.value);

  const state = {
    game: {
      code: game.code,
      status: game.status,
      expected: game.expected_players,
      drawInterval: game.draw_interval_seconds,
      endedReason: game.ended_reason,
    },
    you: {
      id: playerId,
      name: displayNameFor(await getPlayerById(playerId)),
      isHost: game.host_player_id === playerId,
    },
    players: lobby.players,
    joined: lobby.joined,
    // Alias of game.expected. Kept because the lobby counter reads it here and
    // a mismatch shows up as "1 of undefined joined" rather than as an error.
    expected: game.expected_players,
    canStart: lobby.canStart,
    minPlayers: config.game.minPlayers,
    ticket,
    marked,
    draws,
    current: latest
      ? { seq: latest.seq, value: latest.value, tagline: taglineFor(latest.value) }
      : null,
    // Whether this player has already answered the current number, and how
    // many others have - so a reopened page shows the waiting state truthfully
    // instead of offering buttons that were already used.
    yourAnswer: latest
      ? (answers.find((a) => a.value === latest.value)?.answer ?? null)
      : null,
    progress: latest ? await answerProgress(gameId, latest.seq) : { answered: 0, total: lobby.joined },
    countdownSeconds: config.game.startCountdownSeconds,
    // How long the current number has left, so a page opened mid-tick shows a
    // truthful countdown instead of restarting it.
    secondsLeft: game.next_draw_at
      ? Math.max(0, Math.round((new Date(game.next_draw_at) - Date.now()) / 1000))
      : null,
    prizes: claims.prizes,
    brand: config.brandName,
    businessNumber: config.whatsapp.businessNumber,
    // The host shows this to friends; nobody else needs it, so it is only
    // included for the host.
    invite: game.host_player_id === playerId ? inviteUrl(game.code) : null,
    hostName: lobby.players.find((p) => p.isHost)?.name ?? null,
  };

  if (game.status === 'finished') state.results = await getResults(gameId);
  return state;
}

function errorPage(title, detail) {
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;display:grid;place-content:center;
min-height:100vh;margin:0;background:#16151a;color:#e8e6e3;text-align:center;padding:24px}
h1{color:#f0c060;font-size:1.3rem}p{opacity:.7}</style>
<h1>${title}</h1><p>${detail}</p>`;
}
