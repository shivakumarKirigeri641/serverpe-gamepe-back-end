import express, { type Express, type Request, type Response } from 'express';
import { join } from 'node:path';
import { apiPath, env, trialEnd, trialEndLabel } from '../config/env.js';
import { listTestimonials } from '../services/feedback.service.js';
import { logger } from '../utils/logger.js';
import { pool } from '../db/pool.js';
import { markMessageSeen, redis } from '../redis/client.js';
import { handleInbound } from '../services/conversation.service.js';
import { applyStatus } from '../services/message.service.js';
import { EVENT, track } from '../services/analytics.service.js';
import { parseStatuses, parseWebhook } from '../whatsapp/parse.js';
import { createAdminRouter } from './admin.routes.js';
import { createBoardRouter } from './board.routes.js';
import { renderPoliciesPage } from './policies-page.js';
import { listActiveDocuments } from '../services/consent.service.js';
import { getPublicBusinessProfile } from '../services/business.service.js';
import { apiImagePath, getBrandManifest, imagesDir } from '../services/brand.service.js';
import {
  confirmPayment,
  findOrCreateOrder,
  handleWebhook,
  orderBelongsTo,
  verifyWebhookSignature,
} from '../services/payment.service.js';
import { priceForPlayers } from '../services/pricing.service.js';
import { stateByName, stateCodeFromGstin } from '../services/gst.service.js';
import { queryOne } from '../db/pool.js';
import { renderCheckoutClosed, renderCheckoutPage } from './checkout-page.js';
import { renderDemoPage } from './demo-page.js';
import { policiesUrl, verifyCheckoutToken, whatsappReturnUrl } from './board-token.js';
import {
  formatListPrice,
  formatPrice,
  listActivePlans,
  renderDescription,
  renderName,
  renderTagline,
} from '../services/plan.service.js';

import {
  isForThisNumber,
  phoneNumberIdsIn,
  verifyChallenge,
  verifySignature,
} from '../whatsapp/verify.js';
import type { WhatsAppWebhookBody } from '../whatsapp/types.js';

export function createServer(): Express {
  const app = express();

  // Behind ngrok / a load balancer, so the forwarded client IP is the real one.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Baseline hardening. The admin API returns JSON only and the webhook is
  // machine-to-machine, so none of this needs to accommodate a rendered page.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
  });

  // Meta signs the exact bytes it sent, so the raw body must be preserved
  // before any JSON parsing normalises it.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

  const healthHandler = async (_req: Request, res: Response): Promise<void> => {
    const checks: Record<string, string> = {};
    try {
      await pool.query('SELECT 1');
      checks['postgres'] = 'ok';
    } catch {
      checks['postgres'] = 'down';
    }
    try {
      await redis.ping();
      checks['redis'] = 'ok';
    } catch {
      checks['redis'] = 'down';
    }
    const healthy = Object.values(checks).every((v) => v === 'ok');
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', checks });
  };

  // Bare path for load balancers and uptime checks; namespaced path for the
  // platform's own conventions.
  app.get('/health', healthHandler);
  app.get(apiPath('/public/health'), healthHandler);

  // Meta's webhook verification handshake.
  const webhookPath = apiPath(env.WHATSAPP_WEBHOOK_PATH);

  app.get(webhookPath, (req: Request, res: Response) => {
    const challenge = verifyChallenge(req.query as Record<string, unknown>);
    if (challenge) {
      logger.info('whatsapp webhook verified');
      res.status(200).send(challenge);
      return;
    }
    logger.warn({ query: req.query }, 'whatsapp webhook verification failed');
    res.sendStatus(403);
  });

  app.post(webhookPath, async (req: Request, res: Response) => {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from('');

    if (!verifySignature(rawBody, req.header('x-hub-signature-256'))) {
      logger.warn('rejected webhook with a bad signature');
      res.sendStatus(401);
      return;
    }

    // Acknowledge immediately. Meta retries anything slower than a few seconds,
    // and a game tick is far too slow to hold the request open for.
    res.sendStatus(200);

    const body = req.body as WhatsAppWebhookBody;

    // Another number under the same Meta account. Acknowledged so Meta stops
    // retrying, then dropped: replying would answer somebody else's user.
    if (!isForThisNumber(body)) {
      // Warn, not debug. One callback URL can serve several numbers, so seeing
      // another number's traffic is normal — but a WHATSAPP_PHONE_NUMBER_ID
      // that does not match the app drops every real message and looks
      // identical to "nobody has messaged us". Naming both ids turns a silent
      // misconfiguration into an obvious one.
      const seen = phoneNumberIdsIn(body);
      logger.warn(
        { seen, expected: env.WHATSAPP_PHONE_NUMBER_ID },
        'ignored webhook: phone_number_id does not match WHATSAPP_PHONE_NUMBER_ID',
      );
      return;
    }

    // Delivery receipts: the only real evidence a player's phone received a
    // number, as opposed to Meta having merely accepted it from us.
    for (const status of parseStatuses(body)) {
      try {
        await applyStatus(status);
      } catch (err) {
        logger.error({ err, messageId: status.messageId }, 'failed applying delivery status');
      }
    }

    for (const event of parseWebhook(body)) {
      try {
        // Meta redelivers aggressively; without this one "Hi" can open three rooms.
        if (!(await markMessageSeen(event.messageId))) {
          logger.debug({ messageId: event.messageId }, 'duplicate webhook delivery ignored');
          await track({
            type: EVENT.MESSAGE_DUPLICATE_IGNORED,
            source: 'whatsapp',
            waId: event.waId,
            properties: { messageId: event.messageId },
          });
          continue;
        }

        // Inbound logging happens inside handleInbound, where the player and
        // their active game are already resolved.
        await handleInbound(event);
      } catch (err) {
        logger.error({ err, messageId: event.messageId }, 'failed processing inbound event');
        await track({
          type: EVENT.ERROR,
          source: 'whatsapp',
          waId: event.waId,
          properties: { stage: 'inbound', message: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  });

  // The board is a real web page opened in a browser, so it must be framed by
  // nobody but must still be reachable cross-origin from WhatsApp's launcher.
  // Public: the full policies, readable in a browser rather than chat bubbles.
  /**
   * The policies as data, for the website to render at mastipe.in/policies.
   *
   * A privacy policy that lives on api.mastipe.in reads as somebody else's
   * document: the host is unfamiliar, it is not the address on our own
   * stationery, and a link to an API subdomain is exactly the shape of thing
   * people are told not to click. The words still live in the database and are
   * still edited in the admin panel — only the address changes.
   *
   * The server-rendered page below stays: WhatsApp messages sent months ago
   * link to it, and those links must keep working forever.
   */
  app.get(apiPath('/public/legal'), async (req: Request, res: Response) => {
    try {
      const lang = req.query['lang'] === 'hi' ? 'hi' : 'en';
      const docs = await listActiveDocuments();

      res
        .set('Cache-Control', 'public, max-age=300')
        .set('Vary', 'Accept-Language')
        .set('Access-Control-Allow-Origin', '*')
        .json({
          data: docs.map((d) => ({
            key: d.doc_key,
            version: d.version,
            title: (lang === 'hi' && d.title_hi) || d.title,
            summary: (lang === 'hi' && d.summary_hi) || d.summary,
            body: (lang === 'hi' && d.body_hi) || d.body,
            requiresConsent: d.requires_consent,
            // Whether the Hindi has actually been written. The page says so:
            // English remains the operative text, and a reader deserves to
            // know which one they are looking at.
            translated: lang === 'hi' ? Boolean(d.body_hi) : true,
          })),
        });
    } catch (err) {
      logger.error({ err }, 'failed to read legal documents');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get(apiPath('/public/policies'), async (req: Request, res: Response) => {
    try {
      // Hindi on request only. Anything other than 'hi' is English rather than
      // an error: a mistyped or stale link should still show the policies.
      const lang = req.query['lang'] === 'hi' ? 'hi' : 'en';
      const docs = await listActiveDocuments();
      res
        .type('html')
        .set('Cache-Control', 'public, max-age=300')
        .set('Vary', 'Accept-Language')
        .send(renderPoliciesPage(docs, lang));
    } catch (err) {
      logger.error({ err }, 'failed to render policies page');
      res.status(500).type('html').send('<h1>Could not load the policies.</h1>');
    }
  });

  /**
   * Public: the brand assets.
   *
   * Served rather than bundled into each front-end, so the mark is replaced in
   * one place. Cached hard because the files are immutable in practice — a new
   * logo is a new filename, not new bytes behind an old one.
   */
  app.use(
    apiImagePath(),
    // Cross-origin on purpose: the marketing site, the admin panel and an
    // Open Graph crawler all fetch these from a different origin, and the
    // same-origin default set above would block every one of them.
    (_req: Request, res: Response, next) => {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Access-Control-Allow-Origin', '*');
      next();
    },
    express.static(imagesDir(), {
      immutable: true,
      maxAge: '30d',
      fallthrough: false,
      index: false,
      dotfiles: 'ignore',
    }),
  );

  /**
   * Razorpay payment webhook.
   *
   * Mounted whether or not payments are enabled: Razorpay retries a callback
   * for hours, so one arriving just after the flag is flipped must still be
   * verifiable rather than meeting a 404 and being abandoned.
   *
   * Always answers 200, even for a bad signature. Razorpay treats any other
   * status as a delivery failure and retries — which for a forged request would
   * mean answering the attacker over and over. The event is recorded with
   * signature_ok = false and acted on by nobody.
   */
  app.post(apiPath('/public/payments/razorpay/webhook'), async (req: Request, res: Response) => {
    try {
      const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from('');
      const signatureOk = verifyWebhookSignature(raw, req.header('x-razorpay-signature'));

      const body = (req.body ?? {}) as Record<string, unknown>;
      const eventType = typeof body['event'] === 'string' ? body['event'] : 'unknown';
      const eventId = req.header('x-razorpay-event-id') ?? undefined;

      const result = await handleWebhook(eventType, eventId, body, signatureOk);
      res.status(200).json({ received: true, ...result });
    } catch (err) {
      logger.error({ err }, 'razorpay webhook failed');
      // Still 200: a retry would hit the same fault. The event row is the
      // record, and the log is where this gets investigated.
      res.status(200).json({ received: true, handled: false });
    }
  });

  /**
   * The payment page, reachable only through a signed link.
   *
   * Rendered server-side rather than being part of the admin panel: a player
   * opens this from WhatsApp on their phone, and it must work without a login,
   * without a build step, and on a bad connection.
   */
  app.get(`${apiPath('/public/pay')}/:token`, async (req: Request, res: Response) => {
    try {
      const claim = verifyCheckoutToken(String(req.params['token'] ?? ''));
      if (!claim) {
        res.status(403).type('html').send(renderCheckoutClosed('This payment link is not valid.'));
        return;
      }

      const player = await queryOne<{
        id: string;
        wa_id: string;
        display_name: string | null;
        last_region: string | null;
      }>('SELECT id, wa_id, display_name, last_region FROM players WHERE id = $1', [claim.playerId]);
      if (!player) {
        res.status(404).type('html').send(renderCheckoutClosed('This payment could not be found.'));
        return;
      }

      const business = await getPublicBusinessProfile();
      const pricing = await priceForPlayers(claim.players);
      const plans = [pricing.single, pricing.unlimited].filter((p) => p !== null);
      if (plans.length === 0) {
        res.type('html').send(renderCheckoutClosed('No plan is available for that room size.'));
        return;
      }

      // Both orders exist before either is chosen, because the choice happens
      // on the page. Re-used rather than re-created on every page view.
      const options = [];
      for (const plan of plans) {
        const order = await findOrCreateOrder({
          playerId: player.id,
          waId: player.wa_id,
          planKey: plan.planKey,
          amountPaise: plan.amountPaise,
        });

        const unlimited = plan.kind === 'unlimited_24h';
        options.push({
          planKey: plan.planKey,
          label: unlimited ? 'Day pass — unlimited games' : 'One game',
          sublabel: unlimited
            ? `Play as much as you like for 24 hours, up to ${plan.maxPlayers} players`
            : `A single room, up to ${plan.maxPlayers} players`,
          orderId: order.orderId,
          amountPaise: order.amountPaise,
          basePaise: order.basePaise,
          gstPaise: order.gstPaise,
          selected: !unlimited,
          ...(unlimited && pricing.savingPercent
            ? { badge: `Save ${pricing.savingPercent}%` }
            : {}),
        });
      }

      res
        .type('html')
        .set('Cache-Control', 'no-store')
        .send(
          renderCheckoutPage({
            token: String(req.params['token']),
            keyId: env.RAZORPAY_KEY_ID,
            gstPercent: env.GST_PERCENT,
            playerName: player.display_name?.trim() || 'you',
            // Masked: the link can be forwarded, and the last four digits are
            // enough for the payer to know the page is theirs.
            maskedNumber: `+${player.wa_id.slice(0, 2)} ••••• ${player.wa_id.slice(-4)}`,
            players: claim.players,
            bandLabel: pricing.bandLabel,
            options,
            policiesUrl: policiesUrl(),
            confirmPath: `${apiPath('/public/pay')}/${req.params['token']}/confirm`,
            business: {
              legalName: String(business?.['legalName'] ?? 'ServerPe App Solutions'),
              gstin: (business?.['gstin'] as string | undefined) ?? null,
              state:
                ((business?.['address'] as { state?: string } | undefined)?.state) ?? null,
              stateCode: stateCodeFromGstin(business?.['gstin'] as string | undefined),
            },
            // Pre-selected from the state we resolved when they opened their
            // board, if we have one. Still confirmed by the payer — an IP
            // lookup is a guess, and a GST invoice is not the place for one.
            defaultStateCode: stateByName(player.last_region ?? '')?.code ?? null,
          }),
        );
    } catch (err) {
      logger.error({ err }, 'failed to render checkout page');
      res.status(500).type('html').send(renderCheckoutClosed('Could not load this payment.'));
    }
  });

  /**
   * Confirms a payment from the browser.
   *
   * Razorpay hands the page three values after a successful payment; the
   * signature over them is verified here with the key secret, which a player
   * cannot compute. This is the fast path — it credits immediately so the page
   * can send them straight back to WhatsApp — and it is safe to run alongside
   * the webhook, since both credit through the same idempotency key.
   *
   * The token in the URL must match the order being confirmed, so a valid
   * signature for one order cannot be replayed against another.
   */
  app.post(`${apiPath('/public/pay')}/:token/confirm`, async (req: Request, res: Response) => {
    try {
      const claim = verifyCheckoutToken(String(req.params['token'] ?? ''));
      if (!claim) {
        res.status(403).json({ ok: false, error: 'invalid link' });
        return;
      }

      const body = (req.body ?? {}) as Record<string, string>;
      const orderId = String(body['razorpay_order_id'] ?? '');
      const paymentId = String(body['razorpay_payment_id'] ?? '');
      const signature = String(body['razorpay_signature'] ?? '');

      // The link proves who the payer is; this proves the order is theirs, so
      // a genuine signature for one host's order cannot be replayed by another.
      if (!(await orderBelongsTo(orderId, claim.playerId))) {
        res.status(400).json({ ok: false, error: 'order does not belong to this link' });
        return;
      }

      const stateCode = typeof body['stateCode'] === 'string' ? body['stateCode'] : null;
      const result = await confirmPayment(orderId, paymentId, signature, stateCode);
      res.status(result.ok ? 200 : 400).json({
        ...result,
        returnUrl: whatsappReturnUrl(),
      });
    } catch (err) {
      logger.error({ err }, 'payment confirmation failed');
      res.status(500).json({ ok: false, error: 'could not confirm' });
    }
  });

  /**
   * How to play, and what the prizes mean.
   *
   * One page, linked from both the chat menu and the marketing site, so the
   * explanation exists once rather than twice and cannot drift. Entirely
   * static: no game, no player, nothing it can affect — which is what makes it
   * safe to link publicly.
   */
  app.get(apiPath('/public/demo'), (req: Request, res: Response) => {
    const lang = req.query['lang'] === 'hi' ? 'hi' : 'en';
    res
      .type('html')
      .set('Cache-Control', 'public, max-age=600')
      .set('Access-Control-Allow-Origin', '*')
      .send(renderDemoPage(lang));
  });

  app.get(apiPath('/public/brand'), async (_req: Request, res: Response) => {
    try {
      res
        .set('Cache-Control', 'public, max-age=600')
        .set('Access-Control-Allow-Origin', '*')
        .json({ data: await getBrandManifest() });
    } catch (err) {
      logger.error({ err }, 'failed to build brand manifest');
      res.status(500).json({ error: 'Could not read the brand assets' });
    }
  });

  // Public: company details for the marketing site, so the footer, the contact
  // page and the GSTIN all come from one place rather than being retyped.
  app.get(apiPath('/public/business'), async (_req: Request, res: Response) => {
    try {
      const profile = await getPublicBusinessProfile();
      if (!profile) {
        res.status(404).json({ error: 'No business profile configured' });
        return;
      }
      // The trial's end date travels with the company details so the website
      // can print it. It has one source — the admin panel's setting, falling
      // back to FREE_TRIAL_ENDS_AT — because a date typed into marketing copy
      // goes stale the moment the trial moves, and the site would then promise
      // a deadline the product does not keep.
      const end = trialEnd();
      const trial = Number.isNaN(end.getTime())
        ? null
        : {
            endsAt: end.toISOString(),
            label: trialEndLabel(),
            over: new Date() > end,
          };

      res
        .set('Cache-Control', 'public, max-age=300')
        .set('Access-Control-Allow-Origin', '*')
        .json({ data: { ...profile, trial } });
    } catch (err) {
      logger.error({ err }, 'failed to read business profile');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  /**
   * robots.txt for the API host.
   *
   * This origin serves two public pages worth finding — the how-to-play demo
   * and the policies — alongside things that must never be indexed: a board
   * link is a signed URL to one person's ticket, and a checkout link opens a
   * payment page. Those already carry noindex meta tags; this refuses the
   * crawler a step earlier, before it fetches them at all.
   *
   * Served at the host root rather than under the API path, because that is the
   * only place a crawler looks.
   */
  app.get('/robots.txt', (_req: Request, res: Response) => {
    const base = apiPath('/public');
    res
      .type('text/plain')
      .set('Cache-Control', 'public, max-age=3600')
      .send(
        [
          '# api.mastipe.in — the MastiPe back-end.',
          '#',
          '# Two pages here are public and worth finding. Everything else is',
          '# either a private link or an API, and is refused.',
          '',
          'User-agent: *',
          `Allow: ${base}/demo`,
          `Allow: ${base}/policies`,
          `Allow: ${base}/brand`,
          '',
          "# One person's ticket, signed and private.",
          `Disallow: ${base}/board`,
          '# A payment page.',
          `Disallow: ${base}/pay`,
          '# The operator API.',
          `Disallow: ${apiPath('/admin')}`,
          '',
          `Sitemap: ${env.PUBLIC_BASE_URL || 'https://api.mastipe.in'}${base}/sitemap.xml`,
        ].join('\n'),
      );
  });

  /**
   * The public pages this host serves, in both languages.
   *
   * Kept here rather than as a static file because the origin and the API path
   * are configuration — a sitemap with the wrong host in it is worse than none,
   * and it is exactly the sort of thing that goes stale after a domain change.
   */
  app.get(apiPath('/public/sitemap.xml'), (_req: Request, res: Response) => {
    const origin = (env.PUBLIC_BASE_URL || 'https://api.mastipe.in').replace(/\/+$/, '');
    const page = (path: string): string =>
      [
        '  <url>',
        `    <loc>${origin}${path}</loc>`,
        `    <xhtml:link rel="alternate" hreflang="en-IN" href="${origin}${path}"/>`,
        `    <xhtml:link rel="alternate" hreflang="hi-IN" href="${origin}${path}?lang=hi"/>`,
        `    <xhtml:link rel="alternate" hreflang="x-default" href="${origin}${path}"/>`,
        '    <changefreq>monthly</changefreq>',
        '  </url>',
      ].join('\n');

    res
      .type('application/xml')
      .set('Cache-Control', 'public, max-age=3600')
      .send(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
          '        xmlns:xhtml="http://www.w3.org/1999/xhtml">',
          page(apiPath('/public/demo')),
          page(apiPath('/public/policies')),
          '</urlset>',
        ].join('\n'),
      );
  });

  /**
   * The demo video and its cover.
   *
   * Served by the back-end for the same reason the logos are: the marketing
   * site, the WhatsApp demo page and anything else all point at one file, so a
   * re-render replaces it everywhere without a front-end deploy.
   *
   * express.static rather than sendFile, because a video needs HTTP range
   * requests — without them a viewer cannot scrub, and Safari will not play the
   * file at all.
   */
  app.use(
    apiPath('/public/media'),
    (_req: Request, res: Response, next) => {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Cross-Origin-Resource-Policy', 'cross-origin');
      next();
    },
    express.static(join(process.cwd(), 'src', 'media'), {
      // A re-render changes the bytes behind the same name, so a week is the
      // most a stale copy can linger. Immutable would be wrong here.
      maxAge: '7d',
      index: false,
      dotfiles: 'ignore',
      // Only the finished artefacts, never the working files beside them.
      extensions: false,
      setHeaders: (res, path) => {
        if (path.endsWith('.mp4')) res.set('Content-Type', 'video/mp4');
      },
    }),
  );

  // Public: testimonials — the feedback an operator has explicitly approved.
  // Nothing here identifies a player beyond the first name that was approved
  // with it, and an un-approved comment can never reach this endpoint.
  app.get(apiPath('/public/testimonials'), async (_req: Request, res: Response) => {
    try {
      res
        .set('Cache-Control', 'public, max-age=300')
        .set('Access-Control-Allow-Origin', '*')
        .json({ data: await listTestimonials(12) });
    } catch (err) {
      logger.error({ err }, 'failed to read testimonials');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Public: the plans the marketing site advertises, so a price change in the
  // admin panel reaches the website without a deploy.
  app.get(apiPath('/public/plans'), async (req: Request, res: Response) => {
    try {
      // The website is bilingual, so the plan copy has to be too — otherwise a
      // Hindi page prints an English plan name in the middle of itself.
      const lang = req.query.lang === 'hi' ? 'hi' : 'en';
      // Plans that cannot be bought yet are hidden until SHOW_UNAVAILABLE_PLANS
      // is turned on. Showing a "coming soon" price that has not been decided
      // is a promise that may not be kept, and a number a visitor remembers is
      // worse to change later than one they never saw.
      const all = await listActivePlans();
      const plans = env.SHOW_UNAVAILABLE_PLANS ? all : all.filter((p) => p.is_selectable);
      res
        .set('Vary', 'Accept-Language')
        .set('Cache-Control', 'public, max-age=300')
        .set('Access-Control-Allow-Origin', '*')
        .json({
          data: plans.map((p) => ({
            key: p.plan_key,
            name: renderName(p, lang),
            tagline: renderTagline(p, lang),
            description: renderDescription(p),
            // What it costs today (free during the trial) and what it will
            // cost when charging starts — a "coming soon" plan must show its
            // real price, not the trial's zero.
            price: p.is_selectable ? formatPrice(p, lang) : formatListPrice(p, lang),
            listPrice: formatListPrice(p, lang),
            pricePaise: p.price_paise,
            // Both ends of the band: the price list reads "11-25 players",
            // which cannot be built from the upper bound alone.
            minPlayers: p.min_players,
            maxPlayers: p.max_players,
            available: p.is_selectable,
          })),
        });
    } catch (err) {
      logger.error({ err }, 'failed to read plans');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.use(apiPath('/public/board'), createBoardRouter());

  app.use(apiPath(env.ADMIN_BASE_PATH), createAdminRouter());

  app.use((_req: Request, res: Response) => res.sendStatus(404));

  return app;
}

export function startServer(): ReturnType<Express['listen']> {
  const app = createServer();
  return app.listen(env.PORT, () => {
    logger.info(
      {
        port: env.PORT,
        webhook: apiPath(env.WHATSAPP_WEBHOOK_PATH),
        admin: apiPath(env.ADMIN_BASE_PATH),
        health: apiPath('/public/health'),
      },
      'gamepe backend listening',
    );
  });
}
