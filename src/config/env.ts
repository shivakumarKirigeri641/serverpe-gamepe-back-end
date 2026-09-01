import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

/**
 * Configuration comes from `.env`, and only `.env`.
 *
 * One file per machine, holding that machine's values: development on a laptop,
 * production on the server. This is the ordinary convention, and its virtue is
 * that there is nothing to select — no flag to forget and no second file that
 * might be the one actually in force.
 *
 * Precedence: variables already in the environment win, so a container, a
 * systemd unit or a one-off `VAR=x npm start` can override the file without
 * editing it.
 */
const ENV_FILE = '.env';

loadEnv({ path: ENV_FILE });

const bool = z
  .string()
  .default('false')
  .transform((v) => ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5009),
  LOG_LEVEL: z.string().default('info'),
  // Human-readable log lines instead of JSON. Defaults to on in development.
  // Worth turning on in production too while watching a launch: JSON is for
  // machines, and nobody reads a launch through a JSON parser.
  LOG_PRETTY: z.string().optional(),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  /**
   * Required, not optional.
   *
   * Nothing can be sent without it, and — less obviously — it is what the
   * webhook guard compares against to decide whether a message was addressed to
   * us. Left empty, that guard has nothing to compare and would have to allow
   * everything through, silently answering other numbers on the same Meta
   * account. A missing value must stop the process, not weaken it.
   */
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1, 'required: the webhook guard compares against it'),
  /** Not read at runtime; kept for Flow management and support tickets. */
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().default(''),
  WHATSAPP_ACCESS_TOKEN: z.string().default(''),
  WHATSAPP_API_VERSION: z.string().default('v21.0'),
  WHATSAPP_VERIFY_TOKEN: z.string().default('change-me'),
  WHATSAPP_APP_SECRET: z.string().default(''),
  /**
   * Comma-separated whitelist of numbers this instance may message, E.164
   * without '+'. When set, a send to any other number is blocked before it
   * reaches Meta.
   *
   * This exists because a development instance holding a live token will
   * happily message anyone a test fixture invents. Leave empty in production.
   */
  WHATSAPP_ALLOWED_RECIPIENTS: z.string().default(''),

  /** Published Flow id for the in-game ticket screen. Empty = fall back to text + buttons. */
  WHATSAPP_FLOW_ID: z.string().default(''),

  MONETIZATION_ENABLED: bool,
  /**
   * When the free trial closes.
   *
   * Short first window on purpose: its job is to measure how many people turn
   * up, and a shorter one answers that sooner. Extend it once the signup count
   * says whether it is worth extending — see /admin/trial.
   */
  FREE_TRIAL_ENDS_AT: z.string().default('2026-09-06T23:59:59+05:30'),
  DEFAULT_ENTRY_FEE_PAISE: z.coerce.number().int().min(0).default(0),

  /** Game offered when a player just says "play". Must be a registered engine key. */
  DEFAULT_GAME_KEY: z.string().default('tambola'),

  /**
   * Your own number, for smoke-testing the send path. E.164 without '+',
   * e.g. 919886122415. Never used during normal play.
   */
  TEST_PLAYER_WA_ID: z.string().default(''),

  /**
   * Timezone for every day/week boundary in reports, and for the Postgres
   * session. India has no DST, so this is a fixed +05:30 offset.
   */
  APP_TIMEZONE: z.string().default('Asia/Kolkata'),

  /**
   * Ask players to accept the terms before EVERY game rather than once.
   *
   * Default false: a player accepts once, and is asked again automatically
   * whenever a document's version is bumped in the admin panel — so changing
   * the terms still forces fresh consent, without a tap before every round.
   */
  CONSENT_EVERY_GAME: bool,

  // ---------- branding ----------
  /**
   * Resolve an approximate city/state from the board visitor's IP.
   * Uses a free third-party service, so it is opt-in.
   */
  GEO_LOOKUP_ENABLED: bool,

  /** Where players are told to report abuse and appeal a block. */
  SUPPORT_EMAIL: z.string().default('support@mastipe.in'),

  /** Product name shown to players in chat. */
  BRAND_NAME: z.string().default('MastiPe'),
  /** One-line pitch shown under the name in the welcome message. */
  BRAND_TAGLINE: z.string().default('Play together, have Masti.'),

  // ---------- public board ----------
  /**
   * Public origin players reach this server on, used to build board links.
   * In development this is your ngrok https URL; in production, your domain.
   */
  // Where the marketing site lives. Policy links point here, not at the API:
  // a privacy policy served from api.<domain> reads as somebody else's
  // document. Empty falls back to PUBLIC_BASE_URL, so a single-host setup and
  // a local machine both keep working.
  SITE_BASE_URL: z.string().default(''),
  PUBLIC_BASE_URL: z.string().default(''),
  /** Signing key for board links. Falls back to the WhatsApp app secret. */
  BOARD_LINK_SECRET: z.string().default(''),
  /** Where "Back to WhatsApp" sends players — your business number, E.164 no '+'. */
  WHATSAPP_BUSINESS_NUMBER: z.string().default(''),
  /** Cross-promotion shown on the results screen. */
  PROMO_URL: z.string().default('https://quizpe.in'),
  PROMO_TEXT: z
    .string()
    .default(
      'QuizPe is a WhatsApp-based daily revision quiz (Maths) for grades 1 to 10, for CBSE, ICSE and Karnataka State boards.',
    ),
  /** Forwardable line aimed at parents, sent under the promo button. */
  PROMO_SHARE_TEXT: z
    .string()
    .default('Enrol your child for daily Maths revision on WhatsApp — grades 1 to 10, CBSE / ICSE / KA boards.'),

  // ---------- routing ----------
  /** Prefix every route is mounted under, e.g. /serverpe/platform/mastipe/v1 */
  API_BASE_PATH: z.string().default('/serverpe/platform/mastipe/v1'),
  /** WhatsApp webhook path, relative to API_BASE_PATH. */
  WHATSAPP_WEBHOOK_PATH: z.string().default('/public/users/bot/whatsapp/webhook'),
  /** Admin API path, relative to API_BASE_PATH. */
  ADMIN_BASE_PATH: z.string().default('/admin'),

  // ---------- admin api ----------
  /** Bearer key for /api/admin. Empty disables the admin API entirely. */
  ADMIN_API_KEY: z.string().default(''),
  /** Passcode the admin panel logs in with. */
  ADMIN_PASSCODE: z.string().default(''),
  /** How long an admin session stays valid. */
  ADMIN_SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(120),
  /** Failed passcode attempts from one IP before it is locked out. */
  ADMIN_MAX_LOGIN_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
  /** How long that lockout lasts. */
  ADMIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

  /** Comma-separated origins allowed to call the admin API from a browser. */
  ADMIN_CORS_ORIGINS: z.string().default(''),

  // ---------- retention & housekeeping ----------
  /** Days a full message body stays in message_log before being archived. */
  MESSAGE_BODY_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  /** A lobby nobody started is cancelled after this many minutes. */
  LOBBY_EXPIRY_MINUTES: z.coerce.number().int().min(5).default(60),
  /** A running game with no draw for this long is considered stalled. */
  GAME_STALL_MINUTES: z.coerce.number().int().min(5).default(30),
  /** How often the maintenance job runs. */
  MAINTENANCE_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(15),

  /**
   * Platform-wide floor on players before a host may start.
   * Set to 1 to test a round on your own; 2 for real play.
   */
  MIN_PLAYERS_TO_START: z.coerce.number().int().min(1).max(50).default(2),

  /**
   * Consecutive numbers with no response from anyone before a running game is
   * abandoned. Guards against a room that everybody walked away from without
   * pressing Leave, which would otherwise draw all 90 numbers to nobody.
   */
  GAME_INACTIVITY_DRAWS: z.coerce.number().int().min(2).max(30).default(5),

  /**
   * Pause after the last player answers before the next number is drawn.
   *
   * Without it the next number lands in the same instant as the tap, which
   * reads as the board glitching rather than the game moving on.
   */
  EARLY_ADVANCE_DELAY_MS: z.coerce.number().int().min(0).max(5000).default(300),

  // How many draw messages are in flight at once. One at a time cannot fill a
  // room of fifty inside a twenty-second interval; all at once trips the Cloud
  // API's throughput limits. Eight is measured, not guessed — see round.service.
  DRAW_FANOUT_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(8),
  // The largest room the platform will accept, whatever a plan says. The limit
  // is delivery capacity, not the game: a room bigger than the fan-out can
  // serve inside one interval falls behind and never catches up.
  MAX_PLAYERS_PER_GAME: z.coerce.number().int().min(2).max(1000).default(50),
  // The floor between numbers. However fast the room answers, nobody gets the
  // next number sooner than this — a caller who never draws breath is stressful
  // rather than exciting, and the last player served needs a moment to look.
  DRAW_MIN_GAP_SECONDS: z.coerce.number().int().min(2).max(60).default(5),
  // The share of the room that has to answer before the next number comes
  // early. Not everyone: one person putting their phone down should not hold
  // up nine who are watching.
  DRAW_QUORUM_PERCENT: z.coerce.number().int().min(10).max(100).default(70),
  DRAW_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(120).default(12),

  /* ----------------------------------------------------------- payments */

  /**
   * Razorpay. Off until there are prices to charge.
   *
   * While false the order endpoint refuses and nothing about payment is shown
   * to a player. The webhook stays mounted regardless, because Razorpay retries
   * for hours and a callback arriving after the flag is flipped must still be
   * verifiable rather than silently 404ing.
   */
  PAYMENTS_ENABLED: bool,

  /**
   * A "Test payment" row in the chat menu, for exercising Razorpay end to end.
   *
   * Deliberately its own switch rather than something inferred, so turning it
   * off is one obvious line rather than a side effect of another change. It is
   * additionally refused with live keys — a test affordance that survived into
   * production would be a way for any player to open a checkout nobody meant to
   * offer them.
   */
  PAYMENT_TEST_MENU: bool,
  RAZORPAY_KEY_ID: z.string().default(''),
  RAZORPAY_KEY_SECRET: z.string().default(''),
  /** Set in Razorpay Dashboard > Settings > Webhooks. Signs the callbacks. */
  RAZORPAY_WEBHOOK_SECRET: z.string().default(''),

  /**
   * Whether plans that cannot be bought yet appear publicly.
   *
   * False while the pricing is undecided: showing a player a price we have not
   * settled on is a promise we may not keep, and "coming soon" on a number that
   * later changes reads worse than never having shown it.
   */
  SHOW_UNAVAILABLE_PLANS: bool,

  /** Prices include GST (true) or GST is added on top (false). */
  GST_INCLUSIVE: bool,
  GST_PERCENT: z.coerce.number().min(0).max(100).default(18),

  /* ------------------------------------------------------- email alerts */

  MAIL_HOST: z.string().default(''),
  MAIL_PORT: z.coerce.number().int().min(1).max(65535).default(465),
  MAIL_SECURE: bool,
  MAIL_FROM_NAME: z.string().default('MastiPe'),

  /**
   * Alerts are sent from the no-reply mailbox, never from the admin one.
   *
   * A reply to an automated alert should go nowhere rather than into the
   * mailbox support tickets arrive in, and the admin credentials should not be
   * the ones sitting in an SMTP session on every game that ends.
   */
  NOREPLYMAIL: z.string().default(''),
  NOREPLYMAIL_PASSWORD: z.string().default(''),

  ADMINMAIL: z.string().default(''),
  ADMINMAIL_PASSWORD: z.string().default(''),
  ALERT_RECIPIENT: z.string().default(''),

  ADMIN_NOTIFICATIONS_ENABLED: bool,

  /** How often batched alerts are collected and sent as one email. */
  ALERT_DIGEST_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;

/**
 * Refuses to start production with a placeholder still in place.
 *
 * .env ships with CHANGE_ME against every secret. A server that boots
 * anyway would run with a known admin passcode and a signing key printed in the
 * repository — and nothing would look wrong until somebody found it. Failing at
 * boot is loud, immediate, and happens before a single player is exposed.
 */
if (env.NODE_ENV === 'production') {
  const placeholders = (
    [
      'WHATSAPP_ACCESS_TOKEN',
      'BOARD_LINK_SECRET',
      'ADMIN_API_KEY',
      'ADMIN_PASSCODE',
      'DATABASE_URL',
      'NOREPLYMAIL_PASSWORD',
      'ADMINMAIL_PASSWORD',
    ] as const
  ).filter((key) => String(env[key] ?? '').includes('CHANGE_ME'));

  if (placeholders.length > 0) {
    throw new Error(
      `Refusing to start: ${placeholders.join(', ')} still contain CHANGE_ME in ${ENV_FILE}.`,
    );
  }

  // The development safety net, left on by mistake, silently drops every real
  // player's messages. Better to refuse than to look healthy and reach nobody.
  if (env.WHATSAPP_ALLOWED_RECIPIENTS.trim() !== '') {
    throw new Error(
      'Refusing to start: WHATSAPP_ALLOWED_RECIPIENTS must be empty in production, ' +
        'or every player outside that list is silently ignored.',
    );
  }
}

/**
 * Entry fees are only charged once the free trial is over AND the flag is on.
 * Until then every game is free regardless of the configured fee, so the
 * schema can carry real prices before we are ready to collect them.
 */
/**
 * "6 September" — the trial end date as players see it.
 *
 * Derived from FREE_TRIAL_ENDS_AT so the date lives in one place; hard-coding
 * it into greetings is how copy and behaviour drift apart.
 */
/**
 * The trial's end date, as an instant.
 *
 * FREE_TRIAL_ENDS_AT is the default, not the authority: an operator can move
 * the date from the admin panel, and that choice is held here so every sync
 * caller — greetings, plan taglines, the charging switch — sees the same answer
 * without any of them learning about the database.
 */
let trialEndOverride: Date | null = null;

/** Called by the settings service at boot and whenever the date is changed. */
export function setTrialEndOverride(date: Date | null): void {
  trialEndOverride = date && !Number.isNaN(date.getTime()) ? date : null;
}

export function trialEnd(): Date {
  return trialEndOverride ?? new Date(env.FREE_TRIAL_ENDS_AT);
}

export function trialEndLabel(lang: 'en' | 'hi' = 'en'): string {
  const end = trialEnd();
  if (Number.isNaN(end.getTime())) return '';
  // "6 सितंबर" on the Hindi site: a Hindi sentence with an English month name
  // in the middle of it reads as a half-finished translation.
  return new Intl.DateTimeFormat(lang === 'hi' ? 'hi-IN' : 'en-GB', {
    timeZone: env.APP_TIMEZONE,
    day: 'numeric',
    month: 'long',
  }).format(end);
}

/** Joins the base path and a relative path without doubling or dropping slashes. */
export function apiPath(relative: string): string {
  const base = env.API_BASE_PATH.replace(/\/+$/, '');
  const tail = relative.startsWith('/') ? relative : `/${relative}`;
  return `${base}${tail}`;
}

export function isChargingEnabled(now: Date = new Date()): boolean {
  if (!env.MONETIZATION_ENABLED) return false;
  const end = trialEnd();
  if (Number.isNaN(end.getTime())) return true;
  return now > end;
}
