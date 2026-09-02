/**
 * Reads and validates every environment variable the app uses, once, at boot.
 * Anything invalid stops the process here rather than failing mysteriously
 * three layers deep during a live game.
 */
import 'dotenv/config';

const problems = [];

function str(key, fallback = undefined) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') {
    if (fallback === undefined) problems.push(`${key} is required`);
    return fallback;
  }
  return raw.trim();
}

function optional(key, fallback = '') {
  const raw = process.env[key];
  return raw === undefined ? fallback : raw.trim();
}

function int(key, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${key} must be an integer between ${min} and ${max} (got "${raw}")`);
    return fallback;
  }
  return n;
}

function list(key) {
  const raw = optional(key);
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

const NODE_ENV = optional('NODE_ENV', 'development');
const PUBLIC_BASE_URL = str('PUBLIC_BASE_URL', '').replace(/\/+$/, '');

// Everything the app serves is mounted under this prefix, so the service can
// sit behind a shared gateway alongside other products. Normalised to a
// leading slash and no trailing slash, or empty for "mount at the root".
const API_BASE_PATH = (() => {
  const raw = optional('API_BASE_PATH', '').trim();
  if (!raw || raw === '/') return '';
  return ('/' + raw.replace(/^\/+/, '').replace(/\/+$/, ''));
})();
const WHATSAPP_ACCESS_TOKEN = optional('WHATSAPP_ACCESS_TOKEN');

// Dry-run mode: without a token we log outbound messages instead of sending.
// That makes the whole game playable with no Meta account attached.
const whatsappLive = Boolean(WHATSAPP_ACCESS_TOKEN);

if (whatsappLive && /localhost|127\.0\.0\.1/.test(PUBLIC_BASE_URL)) {
  problems.push(
    'PUBLIC_BASE_URL points at localhost while WhatsApp is live. Board links are ' +
      'opened on phones, which cannot reach your localhost. Use your ngrok https URL.',
  );
}

export const config = {
  nodeEnv: NODE_ENV,
  isProduction: NODE_ENV === 'production',
  port: int('PORT', 5009, { min: 1, max: 65535 }),
  logLevel: optional('LOG_LEVEL', 'info'),
  publicBaseUrl: PUBLIC_BASE_URL,
  apiBasePath: API_BASE_PATH,
  /** Origin + prefix. Every link handed to a player is built from this. */
  publicRoot: PUBLIC_BASE_URL + API_BASE_PATH,
  brandName: optional('BRAND_NAME', 'MastiPe'),
  timezone: optional('APP_TIMEZONE', 'Asia/Kolkata'),
  freeTrialEndsAt: optional('FREE_TRIAL_ENDS_AT', '2026-12-31T23:59:59+05:30'),

  db: {
    host: optional('PGHOST', 'localhost'),
    port: int('PGPORT', 5432, { min: 1, max: 65535 }),
    database: str('PGDATABASE'),
    user: str('PGUSER'),
    password: optional('PGPASSWORD'),
  },

  whatsapp: {
    live: whatsappLive,
    accessToken: WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: optional('WHATSAPP_PHONE_NUMBER_ID'),
    businessNumber: optional('WHATSAPP_BUSINESS_NUMBER'),
    verifyToken: optional('WHATSAPP_VERIFY_TOKEN'),
    appSecret: optional('WHATSAPP_APP_SECRET'),
    apiVersion: optional('WHATSAPP_API_VERSION', 'v21.0'),
    webhookPath: optional('WHATSAPP_WEBHOOK_PATH', '/webhook'),
    allowedRecipients: list('WHATSAPP_ALLOWED_RECIPIENTS'),
  },

  boardLinkSecret: optional('BOARD_LINK_SECRET', 'dev-insecure-secret'),

  admin: {
    basePath: optional('ADMIN_BASE_PATH', '/admin'),
    passcode: optional('ADMIN_PASSCODE'),
    apiKey: optional('ADMIN_API_KEY'),
    sessionTtlMinutes: int('ADMIN_SESSION_TTL_MINUTES', 120, { min: 5, max: 1440 }),
    maxLoginAttempts: int('ADMIN_MAX_LOGIN_ATTEMPTS', 5, { min: 1, max: 50 }),
    lockoutMinutes: int('ADMIN_LOCKOUT_MINUTES', 15, { min: 1, max: 1440 }),
    corsOrigins: list('ADMIN_CORS_ORIGINS'),
  },

  /**
   * The legal entity behind the brand, shown in the marketing site footer and
   * its structured data. Left blank rather than invented - an address on a
   * public site has to be the real one.
   */
  business: {
    legalName: optional('BUSINESS_LEGAL_NAME', 'ServerPe App Solutions'),
    supportEmail: optional('SUPPORT_EMAIL', ''),
    gstin: optional('BUSINESS_GSTIN', ''),
    placeOfSupply: optional('BUSINESS_PLACE_OF_SUPPLY', ''),
    address: {
      line1: optional('BUSINESS_ADDRESS_LINE1', ''),
      line2: optional('BUSINESS_ADDRESS_LINE2', ''),
      city: optional('BUSINESS_CITY', ''),
      state: optional('BUSINESS_STATE', ''),
      postalCode: optional('BUSINESS_POSTAL_CODE', ''),
      country: optional('BUSINESS_COUNTRY', 'India'),
    },
  },

  /**
   * The sponsorship plan: pay for a parent's QuizPe subscription, get a window
   * of complimentary games. Defined but NOT enabled - the shape and the price
   * are settled so the copy and the schema are ready, and nothing charges
   * anyone until sponsorshipEnabled flips.
   */
  sponsorship: {
    enabled: optional('SPONSORSHIPS_ENABLED', 'false') === 'true',
    pricePaise: int('SPONSORSHIP_PRICE_PAISE', 9900, { min: 100, max: 10000000 }),
    complimentaryHours: int('SPONSORSHIP_COMPLIMENTARY_HOURS', 24, { min: 1, max: 720 }),
    partner: optional('SPONSORSHIP_PARTNER', 'QuizPe'),
    partnerUrl: optional('QUIZPE_API_URL', ''),
  },

  mail: {
    host: optional('MAIL_HOST'),
    port: int('MAIL_PORT', 587, { min: 1, max: 65535 }),
    secure: optional('MAIL_SECURE', 'false') === 'true',
    user: optional('NOREPLYMAIL') || optional('ADMINMAIL'),
    password: optional('NOREPLYMAIL_PASSWORD') || optional('ADMINMAIL_PASSWORD'),
    fromName: optional('MAIL_FROM_NAME', 'MastiPe'),
    supportInbox: optional('SUPPORT_EMAIL', 'support@mastipe.in'),
  },

  /** The marketing site, for links the bot hands out. */
  siteBaseUrl: optional('SITE_BASE_URL', '').replace(/\/+$/, ''),

  geo: {
    // Server-side IP lookup only - players are never asked for permission.
    enabled: optional('GEO_LOOKUP_ENABLED', 'false') === 'true',
    provider: optional('GEO_PROVIDER', 'ip-api.com'),
    apiKey: optional('GEO_API_KEY'),
  },

  game: {
    drawIntervalSeconds: int('DRAW_INTERVAL_SECONDS', 12, { min: 3, max: 120 }),
    // A pre-roll after the host taps Start, so nobody is still opening their
    // board when the first number lands.
    startCountdownSeconds: int('START_COUNTDOWN_SECONDS', 5, { min: 3, max: 30 }),
    earlyAdvanceDelayMs: int('EARLY_ADVANCE_DELAY_MS', 300, { min: 0, max: 10000 }),
    minPlayers: int('MIN_PLAYERS_TO_START', 2, { min: 2, max: 50 }),
    maxPlayers: int('MAX_PLAYERS_PER_GAME', 50, { min: 2, max: 2000 }),
    lobbyExpiryMinutes: int('LOBBY_EXPIRY_MINUTES', 60, { min: 1, max: 1440 }),
  },
};

if (problems.length) {
  console.error('\nConfiguration problems in .env:\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nSee .env.example for the full list of keys.\n');
  process.exit(1);
}
