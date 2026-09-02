/**
 * The player-facing forms reached from the Options menu: how to play,
 * feedback, and support.
 *
 * Feedback and support are addressed by the same signed token as the board, so
 * a player can only ever submit as themselves — the form does not ask who they
 * are, it already knows.
 */
import { Router } from 'express';
import { config } from '../config/env.js';
import { log } from '../utils/logger.js';
import { verifyBoardToken } from '../utils/code.js';
import { demoPage } from './demo-page.js';
import { feedbackPage, supportPage } from './forms-page.js';
import { getPlayerById, displayNameFor } from '../services/player.service.js';
import { getGameById } from '../services/game.service.js';
import { saveRating, saveComment } from '../services/feedback.service.js';
import { createTicket, ticketsForPlayer } from '../services/support.service.js';
import { recordEvent } from '../services/tracking.service.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Shown so the player can confirm the number is theirs, not so anyone reading
 * over their shoulder learns it.
 */
function maskNumber(waId) {
  const s = String(waId ?? '');
  if (s.length < 6) return s;
  return `+${s.slice(0, 2)} ${'•'.repeat(Math.max(0, s.length - 6))} ${s.slice(-4)}`;
}

export function formsRoutes() {
  const router = Router();

  /** How to play. Public — it is also the website's Demo link. */
  router.get('/public/demo', (req, res) => {
    res.type('html').send(demoPage({ lang: req.query.lang === 'hi' ? 'hi' : 'en' }));
  });

  /** Resolves the signed token to a player. gameId 0 means "not about a game". */
  const resolvePlayer = wrap(async (req, res, next) => {
    const ids = verifyBoardToken(req.params.token);
    if (!ids) {
      return res.status(403).type('html').send(oops('This link is not valid.',
        'Open it from your WhatsApp chat, or ask us for a fresh one.'));
    }
    const player = await getPlayerById(ids.playerId);
    if (!player) {
      return res.status(404).type('html').send(oops('We could not find you.',
        'Message us on WhatsApp and we will sort it out.'));
    }
    req.player = player;
    req.gameId = ids.gameId || null;
    next();
  });

  // ─── feedback ────────────────────────────────────────────────────────────

  router.get('/feedback/:token', resolvePlayer, wrap(async (req, res) => {
    const game = req.gameId ? await getGameById(req.gameId) : null;
    await recordEvent({
      type: 'feedback.opened', source: 'board', req,
      playerId: req.player.id, gameId: req.gameId,
    });
    res.type('html').send(feedbackPage({
      player: { name: displayNameFor(req.player) },
      game,
    }));
  }));

  router.post('/feedback/:token', resolvePlayer, wrap(async (req, res) => {
    const rating = Number(req.body?.rating);
    const comment = String(req.body?.comment ?? '').trim();

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Please pick a rating from 1 to 5' });
    }

    await saveRating({ playerId: req.player.id, gameId: req.gameId, rating });
    if (comment) {
      await saveComment({ playerId: req.player.id, gameId: req.gameId, comment: comment.slice(0, 1000) });
    }

    await recordEvent({
      type: 'feedback.submitted', source: 'board', req,
      playerId: req.player.id, gameId: req.gameId,
      properties: { rating, hasComment: Boolean(comment) },
    });

    log.info('feedback submitted', { playerId: req.player.id, rating, hasComment: Boolean(comment) });
    res.json({ data: { ok: true } });
  }));

  // ─── support ─────────────────────────────────────────────────────────────

  router.get('/support/:token', resolvePlayer, wrap(async (req, res) => {
    await recordEvent({
      type: 'support.opened_form', source: 'board', req, playerId: req.player.id,
    });
    res.type('html').send(supportPage({
      player: { name: displayNameFor(req.player) },
      maskedNumber: maskNumber(req.player.wa_id),
      tickets: await ticketsForPlayer(req.player.id, 5),
    }));
  }));

  router.post('/support/:token', resolvePlayer, wrap(async (req, res) => {
    const message = String(req.body?.message ?? '').trim();
    const name = String(req.body?.name ?? '').trim() || displayNameFor(req.player);
    const email = String(req.body?.email ?? '').trim();

    if (message.length < 10) {
      return res.status(400).json({ error: 'Please tell us a little more — at least a sentence.' });
    }
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'That email address does not look right.' });
    }

    const ticket = await createTicket({
      playerId: req.player.id,
      name: name.slice(0, 80),
      waId: req.player.wa_id,
      email: email.slice(0, 120),
      queryType: String(req.body?.queryType ?? 'other'),
      message: message.slice(0, 2000),
    });

    res.json({ data: { reference: ticket.reference } });
  }));

  return router;
}

function oops(title, detail) {
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;display:grid;place-content:center;
min-height:100vh;margin:0;background:#16151a;color:#e8e6e3;text-align:center;padding:24px}
h1{color:#d4a537;font-size:1.25rem}p{opacity:.7}
a{color:#d4a537}</style>
<h1>${title}</h1><p>${detail}</p>
<p><a href="https://wa.me/${config.whatsapp.businessNumber}">Open WhatsApp</a></p>`;
}
