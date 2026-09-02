/**
 * The unauthenticated endpoints the marketing site reads.
 *
 * The site fetches these rather than hard-coding the facts, so it can never
 * claim something the product does not do: a price, an address, or a policy
 * changed here appears there without a deploy.
 *
 * Everything is deliberately dull and cacheable. Nothing personal is exposed -
 * testimonials carry a first name and nothing else, and only ones an operator
 * has explicitly approved.
 */
import { Router } from 'express';
import { config } from '../config/env.js';
import { pool } from '../db/pool.js';
import { publishedTestimonials } from '../services/feedback.service.js';
import { businessProfile, legalDocuments } from '../services/admin-data.service.js';
import { POLICY_VERSION } from '../services/player.service.js';
import { trialState, maintenance } from '../services/settings.service.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ok = (res, data, seconds = 60) => {
  // Short public cache: the marketing site is read far more than it changes,
  // and an approved testimonial appearing a minute late costs nothing.
  res.set('Cache-Control', `public, max-age=${seconds}`);
  res.json({ data });
};

export function publicRoutes() {
  const router = Router();

  router.get('/public/health', wrap(async (_req, res) => {
    let db = 'down';
    try { await pool.query('SELECT 1'); db = 'up'; } catch { db = 'down'; }
    res.status(db === 'up' ? 200 : 503).json({
      data: { ok: db === 'up', db, service: config.brandName },
    });
  }));

  router.get('/public/brand', (_req, res) => ok(res, {
    name: config.brandName,
    whatsapp_number: config.whatsapp.businessNumber,
    public_base_url: config.publicRoot,
    policies_url: config.policiesUrl,
    // The site falls back to a text wordmark when these are null, which is
    // honest: there is no committed logo set yet.
    primary: {
      icon: null, iconLarge: null, favicon: null, appleTouchIcon: null,
      maskable: null, wordmark: null, wordmarkLight: null,
      mark: null, markLight: null, feature: null,
      openGraph: null, twitter: null, whatsappProfile: null, emailSignature: null,
    },
    assets: [],
  }, 300));

  router.get('/public/business', wrap(async (_q, res) =>
    ok(res, businessProfile(config), 300)));

  /**
   * What a host is offered.
   *
   * One plan is live - the free trial. The sponsorship plan is defined but
   * marked `available: false`, so the shape is settled and the copy is written
   * before it is switched on. Nothing bills anyone while `enabled` is false.
   */
  router.get('/public/plans', wrap(async (req, res) => {
    const hi = req.query.lang === 'hi';
    const trial = trialState();
    const s = config.sponsorship;

    const plans = [{
      key: 'free_trial',
      name: hi ? 'मुफ़्त ट्रायल' : 'Free Trial',
      tagline: hi ? 'अभी सब कुछ मुफ़्त' : 'Everything free, right now',
      price_paise: 0,
      price_label: hi ? 'मुफ़्त' : 'Free',
      currency: 'INR',
      features: hi
        ? ['असीमित गेम', 'अधिकतम ' + config.game.maxPlayers + ' खिलाड़ी', '6 इनाम', 'कोई ऐप नहीं']
        : [
            'Unlimited games',
            `Up to ${config.game.maxPlayers} players per game`,
            'All 6 prizes',
            'No app to install',
          ],
      available: !trial.isOver,
      ends_at: trial.freeTrialEndsAt,
    }];

    plans.push({
      key: 'sponsor_quizpe',
      name: hi ? 'एक अभिभावक को प्रायोजित करें' : 'Sponsor a parent',
      tagline: hi
        ? `QuizPe पर एक अभिभावक को प्रायोजित करें, ${s.complimentaryHours} घंटे का खेल मुफ़्त`
        : `Sponsor a parent on QuizPe, play free for ${s.complimentaryHours} hours`,
      price_paise: s.pricePaise,
      price_label: `₹${Math.round(s.pricePaise / 100)}`,
      currency: 'INR',
      features: hi
        ? [
            'QuizPe पर एक अभिभावक के लिए दैनिक रिवीजन क्विज़',
            `${s.complimentaryHours} घंटे का असीमित खेल`,
            'पहला गेम शुरू होते ही समय शुरू',
          ]
        : [
            'A daily revision quiz for one parent on QuizPe',
            `${s.complimentaryHours} hours of unlimited games, complimentary`,
            'The clock starts when your first game does, not at payment',
          ],
      // Defined, costed and worded - but not on sale. The marketing site is
      // expected to show this as "coming soon" rather than take money.
      available: false,
      coming_soon: true,
    });

    ok(res, plans, 300);
  }));

  /**
   * Planned downtime, for the site's banner.
   *
   * Public and unauthenticated on purpose: it has to be readable exactly when
   * the rest of the platform is not, and it contains nothing private.
   */
  router.get('/public/maintenance', wrap(async (_q, res) => {
    const w = maintenance();
    ok(res, {
      active: w.active,
      upcoming: w.upcoming,
      from: w.from,
      to: w.to,
      message: w.message,
      endsInMinutes: w.endsInMinutes,
      startsInMinutes: w.startsInMinutes,
    }, 30);   // short cache - this is the one thing that must not go stale
  }));

  router.get('/public/legal', wrap(async (_q, res) =>
    ok(res, legalDocuments(config, POLICY_VERSION), 300)));

  /**
   * Approved player comments. Never all feedback - only rows an operator
   * published one at a time from the admin panel.
   */
  router.get('/public/testimonials', wrap(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 50);
    ok(res, await publishedTestimonials(limit), 120);
  }));

  return router;
}
