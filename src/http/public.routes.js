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
import { Router } from "express";
import { config } from "../config/env.js";
import { pool } from "../db/pool.js";
import { publishedTestimonials } from "../services/feedback.service.js";
import { businessProfile } from "../services/admin-data.service.js";
import { listDocuments } from "../services/legal.service.js";
import {
  trialState,
  maintenance,
  playChannel,
  bakraEnabled,
} from "../services/settings.service.js";
import {
  createGame,
  joinGame,
  findActiveGameForPlayer,
  GameError,
} from "../services/game.service.js";
import {
  boardUrl,
  normaliseRoomCode,
  signRoundToken,
} from "../utils/code.js";
import { recordEvent } from "../services/tracking.service.js";
import {
  requestOtp,
  verifyOtp,
  requirePlayer,
  revokePlayerSession,
  publicPlayer,
  AuthError,
} from "../services/player-auth.service.js";
import { smsReady } from "../services/sms.service.js";
import { createRound } from "../services/fatafat.service.js";
import { rateLimit } from "./rate-limit.js";
import { webPlayPage } from "./web-play-page.js";

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
const ok = (res, data, seconds = 60) => {
  // Short public cache: the marketing site is read far more than it changes,
  // and an approved testimonial appearing a minute late costs nothing.
  res.set("Cache-Control", `public, max-age=${seconds}`);
  res.json({ data });
};

const requestPublicRoot = (req) =>
  `${req.protocol}://${req.get("host")}${config.apiBasePath}`.replace(
    /\/+$/,
    "",
  );

/** An absolute URL for one brand image on the current host. */
const img = (baseRoot, file) => `${baseRoot}/public/images/${file}`;

export function publicRoutes() {
  const router = Router();

  const webOnly = (req, res, next) => {
    const play = playChannel();
    if (!play.webEnabled) {
      return res.status(403).json({ error: "Web play is currently disabled" });
    }
    next();
  };

  router.get(
    "/public/health",
    wrap(async (_req, res) => {
      let db = "down";
      try {
        await pool.query("SELECT 1");
        db = "up";
      } catch {
        db = "down";
      }
      res.status(db === "up" ? 200 : 503).json({
        data: { ok: db === "up", db, service: config.brandName },
      });
    }),
  );

  router.get("/public/brand", (req, res) => {
    const play = playChannel();
    const root = requestPublicRoot(req);
    ok(
      res,
      {
        name: config.brandName,
        whatsapp_number: play.whatsappEnabled
          ? config.whatsapp.businessNumber
          : null,
        public_base_url: root,
        policies_url: config.policiesUrl,
        play: {
          mode: play.mode,
          web_enabled: play.webEnabled,
          whatsapp_enabled: play.whatsappEnabled,
          web_url: `${root}/public/play`,
          whatsapp_url:
            play.whatsappEnabled && config.whatsapp.businessNumber
              ? `https://wa.me/${config.whatsapp.businessNumber}?text=${encodeURIComponent("Hi")}`
              : null,
        },

        /**
         * Which games are on offer right now.
         *
         * Reported so the marketing site advertises exactly what the product
         * will actually start. Before this, switching a game off in the admin
         * panel left mastipe.in still selling it, and a visitor who tapped
         * that card arrived at a page with no such button - the worst version
         * of the problem, because it looks like the site is broken rather
         * than like the game is resting.
         */
        games: {
          tambola: true,
          bakra: bakraEnabled(),
        },
        /**
         * The brand set, served from src/images.
         *
         * Absolute URLs, not paths: the marketing site and the admin panel run on
         * different origins to this API, so "/public/images/..." would resolve
         * against their own host and 404. Both front ends fall back to a text
         * wordmark when a slot is null, so a missing file degrades rather than
         * breaks the page.
         */
        primary: {
          favicon: img(root, "favicon-32.png"),
          faviconSmall: img(root, "favicon-16.png"),
          appleTouchIcon: img(root, "apple-touch-icon-180.png"),
          icon: img(root, "icon-192.png"),
          iconLarge: img(root, "icon-512.png"),
          maskable: img(root, "icon-maskable-512.png"),

          wordmark: img(root, "logo-horizontal.svg"),
          wordmarkLight: img(root, "logo-horizontal-light-1000.png"),
          mark: img(root, "logo-mark.svg"),
          markLight: img(root, "mark-white-512.png"),

          feature: img(root, "play-feature-1024x500.png"),
          openGraph: img(root, "og-1200x630.png"),
          twitter: img(root, "twitter-1200x600.png"),
          whatsappProfile: img(root, "whatsapp-profile-640.png"),
          emailSignature: img(root, "logo-email-300.png"),
        },
        assets: [],
      },
      300,
    );
  });

  router.get(
    "/public/business",
    wrap(async (_q, res) => ok(res, businessProfile(config), 300)),
  );

  /**
   * What a host is offered.
   *
   * One plan is live - the free trial. The sponsorship plan is defined but
   * marked `available: false`, so the shape is settled and the copy is written
   * before it is switched on. Nothing bills anyone while `enabled` is false.
   */
  router.get(
    "/public/plans",
    wrap(async (req, res) => {
      const hi = req.query.lang === "hi";
      const trial = trialState();
      const s = config.sponsorship;

      const plans = [
        {
          key: "free_trial",
          name: hi ? "मुफ़्त ट्रायल" : "Free Trial",
          tagline: hi ? "अभी सब कुछ मुफ़्त" : "Everything free, right now",
          price_paise: 0,
          price_label: hi ? "मुफ़्त" : "Free",
          currency: "INR",
          features: hi
            ? [
                "असीमित गेम",
                "अधिकतम " + config.game.maxPlayers + " खिलाड़ी",
                "6 इनाम",
                "कोई ऐप नहीं",
              ]
            : [
                "Unlimited games",
                `Up to ${config.game.maxPlayers} players per game`,
                "All 6 prizes",
                "No app to install",
              ],
          available: !trial.isOver,
          ends_at: trial.freeTrialEndsAt,
        },
      ];

      plans.push({
        key: "sponsor_quizpe",
        name: hi ? "एक अभिभावक को प्रायोजित करें" : "Sponsor a parent",
        tagline: hi
          ? `QuizPe पर एक अभिभावक को प्रायोजित करें, ${s.complimentaryHours} घंटे का खेल मुफ़्त`
          : `Sponsor a parent on QuizPe, play free for ${s.complimentaryHours} hours`,
        price_paise: s.pricePaise,
        price_label: `₹${Math.round(s.pricePaise / 100)}`,
        currency: "INR",
        features: hi
          ? [
              "QuizPe पर एक अभिभावक के लिए दैनिक रिवीजन क्विज़",
              `${s.complimentaryHours} घंटे का असीमित खेल`,
              "पहला गेम शुरू होते ही समय शुरू",
            ]
          : [
              "A daily revision quiz for one parent on QuizPe",
              `${s.complimentaryHours} hours of unlimited games, complimentary`,
              "The clock starts when your first game does, not at payment",
            ],
        // Defined, costed and worded - but not on sale. The marketing site is
        // expected to show this as "coming soon" rather than take money.
        available: false,
        coming_soon: true,
      });

      ok(res, plans, 300);
    }),
  );

  /**
   * Planned downtime, for the site's banner.
   *
   * Public and unauthenticated on purpose: it has to be readable exactly when
   * the rest of the platform is not, and it contains nothing private.
   */
  router.get(
    "/public/maintenance",
    wrap(async (_q, res) => {
      const w = maintenance();
      ok(
        res,
        {
          active: w.active,
          upcoming: w.upcoming,
          from: w.from,
          to: w.to,
          message: w.message,
          endsInMinutes: w.endsInMinutes,
          startsInMinutes: w.startsInMinutes,
        },
        30,
      ); // short cache - this is the one thing that must not go stale
    }),
  );

  /**
   * The policies, from the database.
   *
   * Meta and Razorpay both fetch these during review, so the cache is short:
   * an operator correcting wording in the panel should not be told to wait
   * five minutes before re-submitting.
   */
  router.get(
    "/public/legal",
    wrap(async (req, res) =>
      ok(res, await listDocuments(String(req.query.lang || "en")), 60),
    ),
  );

  /**
   * Approved player comments. Never all feedback - only rows an operator
   * published one at a time from the admin panel.
   */
  router.get(
    "/public/testimonials",
    wrap(async (req, res) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 50);
      ok(res, await publishedTestimonials(limit), 120);
    }),
  );

  router.get(
    "/public/play",
    webOnly,
    wrap(async (req, res) => {
      const play = playChannel();
      const code = normaliseRoomCode(String(req.query.code || ""));
      res.type("html").send(
        webPlayPage({
          mode: play.mode,
          prefillCode: code,
          // Told up front, so a deployment with no SMS provider says so on
          // the first screen instead of after somebody types their number.
          signInAvailable: smsReady(),
          otpLength: config.otp.length,
          // Whether to render the Tap Bakra card at all. Read per request
          // rather than captured once, so flipping it in the admin panel
          // takes effect on the next page load with no restart.
          bakraAvailable: bakraEnabled(),
        }),
      );
    }),
  );

  /* ── sign-in ──────────────────────────────────────────────────────────── */

  /** AuthError carries its own status and a message safe to show. */
  const authFail = (res, err) => {
    if (err.retryAfterSeconds) res.set("Retry-After", String(err.retryAfterSeconds));
    return res.status(err.status || 400).json({
      error: err.message,
      code: err.code,
      retryAfterSeconds: err.retryAfterSeconds ?? undefined,
    });
  };

  // A second, coarser limit in front of the database ones. The per-number and
  // per-IP limits in the service are the real protection; this one simply
  // stops a flood from reaching the database at all.
  // Sized for a room, not a person: everybody at a kitty party is behind the
  // same Wi-Fi, so they share one IP and all sign in within the same minute.
  const otpLimiter = rateLimit({ max: 60, windowMs: 60_000, name: "otp" });

  router.post(
    "/public/play/otp/request",
    webOnly,
    otpLimiter,
    wrap(async (req, res) => {
      try {
        const out = await requestOtp({ phone: req.body?.phone, ip: req.ip });
        ok(res, out, 0);
      } catch (err) {
        if (err instanceof AuthError) return authFail(res, err);
        throw err;
      }
    }),
  );

  router.post(
    "/public/play/otp/verify",
    webOnly,
    otpLimiter,
    wrap(async (req, res) => {
      try {
        const out = await verifyOtp({
          phone: req.body?.phone,
          code: req.body?.code,
          displayName: req.body?.displayName,
          // Only a literal true counts. A page that sends consent without a
          // box being ticked is not consent, and the server should not be
          // able to be talked into recording it.
          consent: req.body?.consent === true,
          ip: req.ip,
          userAgent: req.get("user-agent"),
        });
        await recordEvent({
          type: out.isNew ? "player.registered" : "player.signed_in",
          source: "web",
          playerId: out.player.id,
          req,
        });
        ok(res, out, 0);
      } catch (err) {
        if (err instanceof AuthError) return authFail(res, err);
        throw err;
      }
    }),
  );

  const signedIn = requirePlayer();

  /** Who is signed in, and whether they are already sitting in a game. */
  router.get(
    "/public/play/me",
    webOnly,
    signedIn,
    wrap(async (req, res) => {
      const active = await findActiveGameForPlayer(req.player.id);
      ok(
        res,
        {
          player: publicPlayer(req.player),
          // Offered back, so reopening the page mid-game takes them straight
          // to their seat instead of to a form that would give them a second.
          activeGame: active
            ? {
                code: active.code,
                status: active.status,
                boardUrl: boardUrl(active.id, req.player.id, requestPublicRoot(req)),
              }
            : null,
        },
        0,
      );
    }),
  );

  router.post(
    "/public/play/logout",
    webOnly,
    signedIn,
    wrap(async (req, res) => {
      await revokePlayerSession(req.playerToken);
      ok(res, { ok: true }, 0);
    }),
  );

  /* ── playing ──────────────────────────────────────────────────────────── */

  router.post(
    "/public/play/host",
    webOnly,
    signedIn,
    wrap(async (req, res) => {
      const expectedPlayers = Number(req.body?.expectedPlayers);
      const player = req.player;

      let game;
      try {
        game = await createGame({ hostPlayerId: player.id, expectedPlayers });
      } catch (err) {
        if (err instanceof GameError)
          return res.status(400).json({ error: err.message });
        throw err;
      }

      await recordEvent({
        type: "game.created",
        source: "web",
        playerId: player.id,
        gameId: game.id,
        properties: { code: game.code, expectedPlayers },
      });

      ok(
        res,
        {
          boardUrl: boardUrl(game.id, player.id, requestPublicRoot(req)),
          code: game.code,
          gameId: game.id,
          playerId: player.id,
        },
        0,
      );
    }),
  );

  router.post(
    "/public/play/join",
    webOnly,
    signedIn,
    wrap(async (req, res) => {
      const code = normaliseRoomCode(req.body?.code);
      if (!code)
        return res.status(400).json({ error: "Game code is required" });

      // The signed-in player, not a fresh one. This is what makes a second tap
      // on the same invite return the seat they already have instead of
      // handing the same person another ticket.
      const player = req.player;

      let joined;
      try {
        joined = await joinGame({ code, playerId: player.id });
      } catch (err) {
        if (err instanceof GameError)
          return res.status(400).json({ error: err.message });
        throw err;
      }

      await recordEvent({
        type: joined.alreadyJoined ? "game.rejoined" : "game.joined",
        source: "web",
        playerId: player.id,
        gameId: joined.game.id,
        properties: { code: joined.game.code },
      });

      ok(
        res,
        {
          boardUrl: boardUrl(joined.game.id, player.id, requestPublicRoot(req)),
          code: joined.game.code,
          gameId: joined.game.id,
          playerId: player.id,
        },
        0,
      );
    }),
  );

  /**
   * A round of Tap Bakra.
   *
   * With the WhatsApp entry hidden this is the only way in - the game itself
   * never needed WhatsApp, only its front door did.
   *
   * Refused rather than hidden when the game is switched off. The page already
   * leaves the button out, so reaching this is either a stale tab or somebody
   * calling the API directly, and both should get the same honest answer.
   */
  router.post(
    "/public/play/bakra",
    webOnly,
    signedIn,
    wrap(async (req, res) => {
      if (!bakraEnabled()) {
        return res.status(403).json({ error: "Tap Bakra is not available right now" });
      }
      const lang = req.body?.lang === "hi" ? "hi" : "en";
      const round = await createRound(req.player.id, lang);
      await recordEvent({
        type: "bakra.started",
        source: "web",
        playerId: req.player.id,
        properties: { roundId: round.id, lang },
      });
      ok(
        res,
        {
          url: `${requestPublicRoot(req)}/fatafat/${signRoundToken(round.id, req.player.id)}`,
        },
        0,
      );
    }),
  );

  return router;
}
