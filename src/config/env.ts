import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .string()
  .default('false')
  .transform((v) => ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5009),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  WHATSAPP_PHONE_NUMBER_ID: z.string().default(''),
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
  FREE_TRIAL_ENDS_AT: z.string().default('2026-09-14T23:59:59+05:30'),
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
  /** Product name shown to players in chat. */
  BRAND_NAME: z.string().default('MastiPe'),
  /** One-line pitch shown under the name in the welcome message. */
  BRAND_TAGLINE: z.string().default('Play together, have Masti.'),

  // ---------- public board ----------
  /**
   * Public origin players reach this server on, used to build board links.
   * In development this is your ngrok https URL; in production, your domain.
   */
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

  DRAW_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(120).default(20),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;

/**
 * Entry fees are only charged once the free trial is over AND the flag is on.
 * Until then every game is free regardless of the configured fee, so the
 * schema can carry real prices before we are ready to collect them.
 */
/**
 * "14 September" — the trial end date as players see it.
 *
 * Derived from FREE_TRIAL_ENDS_AT so the date lives in one place; hard-coding
 * it into greetings is how copy and behaviour drift apart.
 */
export function trialEndLabel(): string {
  const end = new Date(env.FREE_TRIAL_ENDS_AT);
  if (Number.isNaN(end.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
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
  const trialEnd = new Date(env.FREE_TRIAL_ENDS_AT);
  if (Number.isNaN(trialEnd.getTime())) return true;
  return now > trialEnd;
}
