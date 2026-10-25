/**
 * Hand Cricket's endpoints.
 *
 * Addressed by a signed token naming one match and one player, like a board or
 * a Tap Bakra link: holding your own link is the only way in, and editing it to
 * become the other side fails the signature.
 */
import { Router } from 'express';
import { config } from '../config/env.js';
import { log } from '../utils/logger.js';
import { verifyCricketToken, cricketUrl, cricketInviteUrl, feedbackUrl, supportUrl } from '../utils/code.js';
import { cricketPage } from './cricket-page.js';
import {
  getMatch, sideOf, stateFor, pick, choose, rematch, leave, playerStats, CricketError,
} from '../services/cricket.service.js';
import { recordEvent } from '../services/tracking.service.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const publicRoot = (req) =>
  `${req.protocol}://${req.get('host')}${config.apiBasePath}`.replace(/\/+$/, '');

const deny = (res, message) =>
  res.status(403).type('html').send(
    `<!doctype html><meta charset="utf-8">
     <meta name="viewport" content="width=device-width,initial-scale=1">
     <body style="background:#0e1116;color:#eaf0f7;font:16px system-ui;padding:40px;text-align:center">
       <h2 style="color:#f5b83d">Hand Cricket</h2><p>${message}</p>
       <p><a style="color:#f5b83d" href="${config.apiBasePath || ''}/public/play">Back to the games</a></p>
     </body>`);

export function cricketRoutes() {
  const router = Router();

  /** Token in, verified (match, side) out - or nothing happens. */
  const resolve = wrap(async (req, res, next) => {
    const ids = verifyCricketToken(req.params.token);
    if (!ids) return res.status(403).json({ error: 'invalid link' });
    const match = await getMatch(ids.matchId);
    if (!match) return res.status(404).json({ error: 'match not found' });
    const side = sideOf(match, ids.playerId);
    if (!side) return res.status(403).json({ error: 'not your match' });
    req.match = match; req.side = side; req.playerId = ids.playerId;
    next();
  });

  /** The state, with the links this player may need: the invite while waiting, the rematch once offered. */
  async function view(req, match) {
    const s = await stateFor(match, req.side);
    const root = publicRoot(req);
    s.inviteUrl = s.mode === 'friend' && s.code ? cricketInviteUrl(s.code, root) : null;
    s.rematchUrl = s.rematchId ? cricketUrl(s.rematchId, req.playerId, root) : null;
    return s;
  }

  const fail = (res, err) => {
    if (err instanceof CricketError) return res.status(409).json({ error: err.message, code: err.code });
    throw err;
  };

  router.get('/cricket/:token', wrap(async (req, res) => {
    const ids = verifyCricketToken(req.params.token);
    if (!ids) return deny(res, 'This link is not valid.');
    const match = await getMatch(ids.matchId);
    if (!match || !sideOf(match, ids.playerId)) return deny(res, 'This link is not valid.');
    req.side = sideOf(match, ids.playerId); req.playerId = ids.playerId;
    const [state, stats] = await Promise.all([view(req, match), playerStats(ids.playerId)]);
    res.type('html').send(cricketPage({
      token: req.params.token,
      apiBase: config.apiBasePath || '',
      state,
      stats,
      lang: match.lang,
      feedbackUrl: feedbackUrl(ids.playerId, 0),
      supportUrl: supportUrl(ids.playerId, 0),
    }));
  }));

  router.get('/cricket/:token/state', resolve, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await view(req, req.match));
  }));

  router.post('/cricket/:token/pick', resolve, wrap(async (req, res) => {
    try {
      const m = await pick(req.match.id, req.side, req.body?.n, req.body?.turn, req.body?.call ?? null);
      if (m.status === 'finished') {
        await recordEvent({ type: 'cricket.finished', source: 'web', playerId: req.playerId,
          properties: { matchId: Number(m.id), mode: m.mode, winner: m.winner } });
      }
      res.json(await view(req, m));
    } catch (err) { fail(res, err); }
  }));

  router.post('/cricket/:token/choose', resolve, wrap(async (req, res) => {
    try {
      res.json(await view(req, await choose(req.match.id, req.side, req.body?.choice)));
    } catch (err) { fail(res, err); }
  }));

  router.post('/cricket/:token/again', resolve, wrap(async (req, res) => {
    try {
      const m = await rematch(req.match.id, req.playerId);
      await recordEvent({ type: 'cricket.rematch', source: 'web', playerId: req.playerId,
        properties: { from: Number(req.match.id), matchId: Number(m.id), mode: m.mode } });
      log.info('cricket again', { from: req.match.id, to: m.id, playerId: req.playerId });
      res.json({ url: cricketUrl(m.id, req.playerId, publicRoot(req)) });
    } catch (err) { fail(res, err); }
  }));

  router.post('/cricket/:token/leave', resolve, wrap(async (req, res) => {
    res.json(await view(req, await leave(req.match.id, req.side)));
  }));

  return router;
}
