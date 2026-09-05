/**
 * Fatafat's endpoints.
 *
 * Every route is addressed by a signed token naming one round and one player,
 * exactly like a board link - so holding somebody's URL is the only way in,
 * and editing it to become another player fails the signature.
 *
 * The page is served one question at a time and never learns an answer before
 * it has submitted one. That shape is the whole security model: there is no
 * secret in the document to find.
 */
import { Router } from 'express';
import { config } from '../config/env.js';
import { log } from '../utils/logger.js';
import { verifyRoundToken, fatafatUrl, feedbackUrl, supportUrl, signRoundToken } from '../utils/code.js';
import { fatafatPage } from './fatafat-page.js';
import { getPlayerById, displayNameFor } from '../services/player.service.js';
import { businessProfile } from '../services/admin-data.service.js';
import {
  getRound, createRound, serveNext, submitAnswer, roundReport, playerStats,
  playerAnalytics, roundList, FatafatError,
} from '../services/fatafat.service.js';
import { query } from '../db/pool.js';
import { UI as HI_UI } from '../games/fatafat/hindi.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const deny = (res, message) =>
  res.status(403).type('html').send(
    `<!doctype html><meta charset="utf-8">
     <meta name="viewport" content="width=device-width,initial-scale=1">
     <body style="background:#16151a;color:#e8e6e3;font:16px system-ui;padding:40px;text-align:center">
       <h2 style="color:#d4a537">Tap Bakra</h2><p>${message}</p>
       <p style="color:#9a94a5;font-size:14px">Ask for a fresh link on WhatsApp.</p>
     </body>`);

/** +91 xxxxx xx415 - recognisable to its owner, no use to anyone else. */
function maskNumber(waId) {
  const digits = String(waId || '').replace(/\D/g, '');
  if (digits.length < 4) return null;
  const last = digits.slice(-3);
  const cc = digits.length > 10 ? '+' + digits.slice(0, digits.length - 10) + ' ' : '';
  return cc + 'xxxxx xx' + last;
}

/**
 * The reference printed on the document.
 *
 * Round id and date, not a random string: somebody quoting this in a support
 * message should lead us straight to the row, and a reference nobody can look
 * up is decoration.
 */
function reportReference(round) {
  const d = new Date(round.created_at);
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
  return 'TB-' + ymd + '-' + String(round.id).padStart(5, '0');
}

export function fatafatRoutes() {
  const router = Router();

  /** Token in, verified (round, player) out - or nothing happens. */
  const resolve = wrap(async (req, res, next) => {
    const ids = verifyRoundToken(req.params.token);
    if (!ids) return res.status(403).json({ error: 'invalid link' });

    const round = await getRound(ids.roundId);
    if (!round) return res.status(404).json({ error: 'round not found' });
    // The signature proves the pair was issued together; this proves the round
    // still belongs to that player, which is what stops a replayed old link
    // from reaching somebody else's data.
    if (Number(round.player_id) !== ids.playerId) return res.status(403).json({ error: 'not your round' });

    req.round = round;
    req.playerId = ids.playerId;
    next();
  });

  router.get('/fatafat/:token', wrap(async (req, res) => {
    const ids = verifyRoundToken(req.params.token);
    if (!ids) return deny(res, 'This link is not valid.');
    const round = await getRound(ids.roundId);
    if (!round || Number(round.player_id) !== ids.playerId) return deny(res, 'This link is not valid.');

    const [player, stats] = await Promise.all([
      getPlayerById(ids.playerId),
      playerStats(ids.playerId),
    ]);
    res.type('html').send(fatafatPage({
      token: req.params.token,
      playerName: player ? displayNameFor(player) : null,
      questionCount: round.question_count,
      timeLimitMs: round.time_limit_ms,
      apiBase: config.apiBasePath || '',
      waNumber: config.whatsapp.businessNumber,
      stats,
      // gameId 0 - the feedback form already means "not about a game" by it.
      feedbackUrl: feedbackUrl(ids.playerId, 0),
      supportUrl: supportUrl(ids.playerId, 0),
      roundStatus: round.status,
      lang: round.lang,
      ui: round.lang === 'hi' ? HI_UI : null,
      // A report somebody keeps or forwards has to say who it is about and who
      // issued it. All of this is already configured for invoices and the
      // marketing site - none of it is a second source of truth.
      doc: {
        business: businessProfile(config),
        timezone: config.timezone,
        player: {
          name: player ? displayNameFor(player) : null,
          // Last three digits only. Enough for the holder to recognise their
          // own report, useless to anybody else who is handed it.
          masked: player ? maskNumber(player.wa_id) : null,
          id: ids.playerId,
        },
        reference: reportReference(round),
        siteUrl: config.siteBaseUrl || null,
      },
    }));
  }));

  router.get('/fatafat/:token/next', resolve, wrap(async (req, res) => {
    if (req.round.status !== 'open') return res.json({ done: true });
    res.json(await serveNext(req.round));
  }));

  router.post('/fatafat/:token/answer', resolve, wrap(async (req, res) => {
    try {
      // Re-read: serveNext moved current_seq forward after req.round was taken.
      const round = await getRound(req.round.id);
      const out = await submitAnswer(
        round,
        Number(req.body?.seq),
        Array.isArray(req.body?.tapped) ? req.body.tapped : [],
        Number(req.body?.ms),
      );
      res.json(out);
    } catch (err) {
      if (err instanceof FatafatError) return res.status(409).json({ error: err.message, code: err.code });
      throw err;
    }
  }));

  router.get('/fatafat/:token/report', resolve, wrap(async (req, res) => {
    const report = await roundReport(req.round.id);
    if (!report) return res.status(404).json({ error: 'no report' });
    res.json(report);
  }));

  /**
   * The player's own rounds, each with its own signed report link.
   *
   * Signed per round rather than one link that takes an id: a token that names
   * the round is the only thing standing between a player and somebody else's
   * report, and a query parameter would not be.
   */
  router.get('/fatafat/:token/rounds', resolve, wrap(async (req, res) => {
    const rounds = await roundList(req.playerId, 20);
    res.json(rounds.map((r) => ({
      ...r,
      url: '/fatafat/' + signRoundToken(r.id, req.playerId),
    })));
  }));

  router.get('/fatafat/:token/analytics', resolve, wrap(async (req, res) => {
    res.json(await playerAnalytics(req.playerId));
  }));

  /**
   * Another round, for the same player.
   *
   * A new round means a new id and therefore a new signed link, so the page
   * redirects rather than reusing the one in the address bar - the old token
   * still opens the old round's report, which is what you want if somebody has
   * shared their score.
   */
  /**
   * Switch the round between English and Hindi.
   *
   * Only before the first answer. Allowing it mid-round would hand out a free
   * clock reset on every toggle, because the question would be served again.
   */
  router.post('/fatafat/:token/lang', resolve, wrap(async (req, res) => {
    const lang = req.body?.lang === 'hi' ? 'hi' : 'en';
    const { rows } = await query(
      `UPDATE fatafat_rounds r
          SET lang = $2
        WHERE r.id = $1 AND r.status = 'open'
          AND NOT EXISTS (SELECT 1 FROM fatafat_answers a WHERE a.round_id = r.id)
        RETURNING lang`,
      [req.round.id, lang],
    );
    if (rows[0]) return res.json({ lang: rows[0].lang });

    // Already played, or already answered. Switching this round would mean
    // serving a question again; a new round in the language they asked for is
    // what they actually wanted, and it costs them nothing they had.
    const fresh = await createRound(req.playerId, lang);
    res.json({ lang, url: fatafatUrl(fresh.id, req.playerId) });
  }));

  router.post('/fatafat/:token/again', resolve, wrap(async (req, res) => {
    // A replay keeps the language they were just playing in.
    const round = await createRound(req.playerId, req.round.lang);
    log.info('fatafat replay', { playerId: req.playerId, roundId: round.id });
    res.json({ url: fatafatUrl(round.id, req.playerId) });
  }));

  return router;
}
