/**
 * Reads and validates every environment variable the app uses, once, at boot.
 * Anything invalid stops the process here rather than failing mysteriously
 * three layers deep during a live game.
 */
import "dotenv/config";

const problems = [];

function str(key, fallback = undefined) {
  const raw = process.env[key];
  if (raw === undefined || raw === "") {
    if (fallback === undefined) problems.push(`${key} is required`);
    return fallback;
  }
  return raw.trim();
}

function optional(key, fallback = "") {
  const raw = process.env[key];
  return raw === undefined ? fallback : raw.trim();
}

function int(key, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(
      `${key} must be an integer between ${min} and ${max} (got "${raw}")`,
    );
    return fallback;
  }
  return n;
}

function list(key) {
  const raw = optional(key);
  return raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

const NODE_ENV = optional("NODE_ENV", "development");
const PUBLIC_BASE_URL = str("PUBLIC_BASE_URL", "").replace(/\/+$/, "");
const PLAY_CHANNEL_MODE = optional(
  "PLAY_CHANNEL_MODE",
  "whatsapp",
).toLowerCase();

// Everything the app serves is mounted under this prefix, so the service can
// sit behind a shared gateway alongside other products. Normalised to a
// leading slash and no trailing slash, or empty for "mount at the root".
const API_BASE_PATH = (() => {
  const raw = optional("API_BASE_PATH", "").trim();
  if (!raw || raw === "/") return "";
  return "/" + raw.replace(/^\/+/, "").replace(/\/+$/, "");
})();
const SITE_BASE_URL = optional("SITE_BASE_URL", "").replace(/\/+$/, "");
const WHATSAPP_ACCESS_TOKEN = optional("WHATSAPP_ACCESS_TOKEN");

/*
 * SMS, for the web sign-in code.
 *
 * Read under the FAST2SMS_* names that are already in .env, with the generic
 * SMS_* names kept as aliases - the same two-names-one-value arrangement the
 * mail block uses, and for the same reason: an operator should not have to
 * rename working variables because the code prefers different spelling, and
 * switching provider later should not mean editing .env on every machine.
 *
 * The provider is DERIVED rather than demanded. With a key present it is
 * fast2sms; with no key it is the log provider. The alternative - defaulting
 * SMS_PROVIDER to "log" while a real key sits in the file - is the quietest
 * possible failure: sign-in appears to work, every code goes to the server
 * log, and nobody can get in.
 */
const SMS_API_KEY = optional("FAST2SMSAPIKEY") || optional("SMS_API_KEY");
const SMS_PROVIDER = (
  optional("SMS_PROVIDER") || (SMS_API_KEY ? "fast2sms" : "log")
).toLowerCase();
const SMS_ROUTE = (
  optional("FAST2SMS_ROUTE") || optional("SMS_ROUTE") || "dlt"
).toLowerCase();
const SMS_SENDER_ID = optional("FAST2SMS_SENDER_ID") || optional("SMS_SENDER_ID");
const SMS_TEMPLATE_ID =
  optional("FAST2SMS_DLT_MESSAGE_ID") || optional("SMS_TEMPLATE_ID");

/*
 * The approved wording, and the entity it is registered to.
 *
 * Needed ONLY on the dlt_manual route, where the full text is sent with the
 * request. On the plain dlt route Fast2SMS holds the approved template against
 * the message id and fills it in itself, so the text here is unused - kept
 * anyway because it is the one place somebody can read what a player actually
 * receives without logging into the operator portal.
 *
 * {#var#} is the DLT placeholder and is replaced with the code. A template
 * written with a bare x or XXXX instead will not substitute, so the code
 * checks for the placeholder rather than assuming it is there.
 */
const SMS_MESSAGE_TEXT =
  optional("FAST2SMS_MESSAGE_TEXT") || optional("SMS_MESSAGE_TEXT");
const SMS_ENTITY_ID = optional("FAST2SMS_ENTITY_ID") || optional("SMS_ENTITY_ID");

/*
 * Who an SMS may be sent to.
 *
 * Falls back to the WhatsApp allowlist so one list governs both channels. That
 * default is deliberate: the standing rule on this project is that outbound
 * messages go nowhere except the allowlist, and a brand-new channel that
 * ignored it would be a hole opened by adding a feature. Empty means no
 * restriction, matching the WhatsApp client exactly.
 */
const SMS_ALLOWED = (() => {
  const own = list("SMS_ALLOWED_RECIPIENTS");
  return own.length ? own : list("WHATSAPP_ALLOWED_RECIPIENTS");
})();

if (SMS_PROVIDER === "fast2sms") {
  if (!SMS_API_KEY) {
    problems.push(
      "SMS_PROVIDER is fast2sms but no API key is set (FAST2SMSAPIKEY)",
    );
  }
  if (!["dlt", "dlt_manual", "otp", "q"].includes(SMS_ROUTE)) {
    problems.push(
      `FAST2SMS_ROUTE must be dlt, dlt_manual, otp or q (got "${SMS_ROUTE}")`,
    );
  }
  // dlt_manual carries the wording itself, so all four parts have to be here.
  if (SMS_ROUTE === "dlt_manual") {
    if (!SMS_MESSAGE_TEXT) {
      problems.push(
        "FAST2SMS_ROUTE=dlt_manual needs FAST2SMS_MESSAGE_TEXT - the approved wording, " +
          "with {#var#} where the code goes",
      );
    } else if (!SMS_MESSAGE_TEXT.includes("{#var#}")) {
      problems.push(
        'FAST2SMS_MESSAGE_TEXT has no {#var#} placeholder, so the code would never ' +
          'appear in the message. Write it as "{#var#} is your otp to verify with ..."',
      );
    }
    if (!SMS_ENTITY_ID) {
      problems.push(
        "FAST2SMS_ROUTE=dlt_manual needs FAST2SMS_ENTITY_ID (your DLT principal entity id)",
      );
    }
    if (!SMS_SENDER_ID) {
      problems.push("FAST2SMS_ROUTE=dlt_manual needs FAST2SMS_SENDER_ID");
    }
    if (!SMS_TEMPLATE_ID) {
      problems.push("FAST2SMS_ROUTE=dlt_manual needs FAST2SMS_DLT_MESSAGE_ID (the DLT template id)");
    }
  }
  // The DLT route is the one India actually requires for transactional SMS,
  // and Fast2SMS rejects it outright without both of these. Caught here
  // rather than on the first player who tries to sign in.
  if (SMS_ROUTE === "dlt") {
    if (!SMS_SENDER_ID) {
      problems.push(
        "FAST2SMS_ROUTE=dlt needs FAST2SMS_SENDER_ID (your approved DLT header, e.g. SRVRPE)",
      );
    }
    if (!SMS_TEMPLATE_ID) {
      problems.push(
        "FAST2SMS_ROUTE=dlt needs FAST2SMS_DLT_MESSAGE_ID (the approved template id from Fast2SMS)",
      );
    }
  }
}

// Dry-run mode: without a token we log outbound messages instead of sending.
// That makes the whole game playable with no Meta account attached.
const whatsappLive = Boolean(WHATSAPP_ACCESS_TOKEN);

if (!["whatsapp", "web", "hybrid"].includes(PLAY_CHANNEL_MODE)) {
  problems.push(
    `PLAY_CHANNEL_MODE must be one of whatsapp, web or hybrid (got "${PLAY_CHANNEL_MODE}")`,
  );
}

if (whatsappLive && /localhost|127\.0\.0\.1/.test(PUBLIC_BASE_URL)) {
  problems.push(
    "PUBLIC_BASE_URL points at localhost while WhatsApp is live. Board links are " +
      "opened on phones, which cannot reach your localhost. Use your ngrok https URL.",
  );
}

export const config = {
  nodeEnv: NODE_ENV,
  isProduction: NODE_ENV === "production",
  port: int("PORT", 5009, { min: 1, max: 65535 }),
  logLevel: optional("LOG_LEVEL", "info"),
  publicBaseUrl: PUBLIC_BASE_URL,
  apiBasePath: API_BASE_PATH,
  /** Origin + prefix. Every link handed to a player is built from this. */
  publicRoot: PUBLIC_BASE_URL + API_BASE_PATH,
  brandName: optional("BRAND_NAME", "MastiPe"),
  timezone: optional("APP_TIMEZONE", "Asia/Kolkata"),
  freeTrialEndsAt: optional("FREE_TRIAL_ENDS_AT", "2026-12-31T23:59:59+05:30"),
  playChannelMode: PLAY_CHANNEL_MODE,

  db: {
    host: optional("PGHOST", "localhost"),
    port: int("PGPORT", 5432, { min: 1, max: 65535 }),
    database: str("PGDATABASE"),
    user: str("PGUSER"),
    password: optional("PGPASSWORD"),
  },

  whatsapp: {
    live: whatsappLive,
    accessToken: WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: optional("WHATSAPP_PHONE_NUMBER_ID"),
    businessNumber: optional("WHATSAPP_BUSINESS_NUMBER"),
    verifyToken: optional("WHATSAPP_VERIFY_TOKEN"),
    appSecret: optional("WHATSAPP_APP_SECRET"),
    apiVersion: optional("WHATSAPP_API_VERSION", "v21.0"),
    webhookPath: optional("WHATSAPP_WEBHOOK_PATH", "/webhook"),
    allowedRecipients: list("WHATSAPP_ALLOWED_RECIPIENTS"),
  },

  boardLinkSecret: optional("BOARD_LINK_SECRET", "dev-insecure-secret"),

  /**
   * Web sign-in: a mobile number and a one-time code sent by SMS.
   *
   * SMS_PROVIDER=log writes the code to the server log instead of sending it.
   * That is for development only - anyone who can read the log can sign in as
   * anybody - so it refuses to run in production unless OTP_LOG_IN_PRODUCTION
   * says, explicitly, that somebody meant it.
   */
  otp: {
    provider: SMS_PROVIDER,
    apiKey: SMS_API_KEY,
    senderId: SMS_SENDER_ID,
    templateId: SMS_TEMPLATE_ID,
    route: SMS_ROUTE,
    messageText: SMS_MESSAGE_TEXT,
    entityId: SMS_ENTITY_ID,
    allowedRecipients: SMS_ALLOWED,

    /**
     * Numbers that always get the same code, and no SMS.
     *
     *   OTP_FIXED_CODES=919886122415:6416
     *
     * For the operator's own number: sign in to play or to check something on
     * the live site without waiting for an SMS or spending a credit.
     *
     * ── Why this is configuration and not a constant in the source ────────
     *
     * A number-and-code pair written into a file goes into git history, on a
     * remote, permanently - it cannot be rotated and it cannot be removed. In
     * .env it is deletable in one line and was never published.
     *
     * ── What it does NOT bypass ───────────────────────────────────────────
     *
     * Everything else. The code is still issued into otp_requests on request,
     * still expires, is still single-use, still counts wrong guesses against
     * OTP_MAX_ATTEMPTS, and still requires the consent box. The only
     * differences are that the value is predictable and no SMS is sent - so
     * the blast radius is "somebody who knows both the number and the code can
     * sign in as that player", not "the sign-in check is off".
     *
     * Every use is logged at WARN, and the admin health page reports it as a
     * warning for as long as it is set, so it cannot be left on and forgotten.
     */
    fixedCodes: (() => {
      const map = new Map();
      for (const pair of list("OTP_FIXED_CODES")) {
        const [rawPhone, rawCode] = String(pair).split(":");
        const phone = String(rawPhone ?? "").replace(/\D/g, "");
        const code = String(rawCode ?? "").trim();
        if (!phone || !/^\d{4,8}$/.test(code)) {
          problems.push(
            `OTP_FIXED_CODES entry "${pair}" is not <phone>:<4-8 digits>`,
          );
          continue;
        }
        map.set(phone, code);
      }
      return map;
    })(),
    length: int("OTP_LENGTH", 6, { min: 4, max: 8 }),
    ttlSeconds: int("OTP_TTL_SECONDS", 300, { min: 60, max: 1800 }),
    maxAttempts: int("OTP_MAX_ATTEMPTS", 5, { min: 1, max: 10 }),
    resendAfterSeconds: int("OTP_RESEND_AFTER_SECONDS", 30, { min: 10, max: 600 }),
    perPhonePerHour: int("OTP_PER_PHONE_PER_HOUR", 5, { min: 1, max: 50 }),
    // Generous on purpose. A party signs in together from ONE home Wi-Fi, so
    // a tight per-IP cap locks out a whole living room. The per-number limits
    // above are what cap SMS cost; this only has to stop a single machine
    // pumping codes to thousands of different numbers.
    perIpPerHour: int("OTP_PER_IP_PER_HOUR", 150, { min: 1, max: 2000 }),
    sessionDays: int("PLAYER_SESSION_DAYS", 30, { min: 1, max: 365 }),
    allowLogInProduction: optional("OTP_LOG_IN_PRODUCTION") === "true",
  },

  admin: {
    basePath: optional("ADMIN_BASE_PATH", "/admin"),
    passcode: optional("ADMIN_PASSCODE"),
    apiKey: optional("ADMIN_API_KEY"),
    sessionTtlMinutes: int("ADMIN_SESSION_TTL_MINUTES", 120, {
      min: 5,
      max: 1440,
    }),
    maxLoginAttempts: int("ADMIN_MAX_LOGIN_ATTEMPTS", 5, { min: 1, max: 50 }),
    lockoutMinutes: int("ADMIN_LOCKOUT_MINUTES", 15, { min: 1, max: 1440 }),
    corsOrigins: list("ADMIN_CORS_ORIGINS"),
  },

  /**
   * The legal entity behind the brand, shown in the marketing site footer and
   * its structured data. Left blank rather than invented - an address on a
   * public site has to be the real one.
   */
  business: {
    legalName: optional("BUSINESS_LEGAL_NAME", "ServerPe App Solutions"),
    supportEmail: optional("SUPPORT_EMAIL", ""),
    gstin: optional("BUSINESS_GSTIN", ""),
    placeOfSupply: optional("BUSINESS_PLACE_OF_SUPPLY", ""),
    address: {
      line1: optional("BUSINESS_ADDRESS_LINE1", ""),
      line2: optional("BUSINESS_ADDRESS_LINE2", ""),
      city: optional("BUSINESS_CITY", ""),
      state: optional("BUSINESS_STATE", ""),
      postalCode: optional("BUSINESS_POSTAL_CODE", ""),
      country: optional("BUSINESS_COUNTRY", "India"),
    },
  },

  /**
   * The sponsorship plan: pay for a parent's QuizPe subscription, get a window
   * of complimentary games. Defined but NOT enabled - the shape and the price
   * are settled so the copy and the schema are ready, and nothing charges
   * anyone until sponsorshipEnabled flips.
   */
  sponsorship: {
    enabled: optional("SPONSORSHIPS_ENABLED", "false") === "true",
    pricePaise: int("SPONSORSHIP_PRICE_PAISE", 9900, {
      min: 100,
      max: 10000000,
    }),
    complimentaryHours: int("SPONSORSHIP_COMPLIMENTARY_HOURS", 24, {
      min: 1,
      max: 720,
    }),
    partner: optional("SPONSORSHIP_PARTNER", "QuizPe"),
    partnerUrl: optional("QUIZPE_API_URL", ""),
  },

  mail: {
    host: optional("MAIL_HOST"),
    port: int("MAIL_PORT", 587, { min: 1, max: 65535 }),
    secure: optional("MAIL_SECURE", "false") === "true",
    /**
     * SMTP credentials, under any of the three names in the env files.
     *
     * MAIL_USER / MAIL_PASSWORD come first because they are the obvious names
     * and they sit right next to MAIL_HOST and MAIL_PORT. They used to be read
     * by nothing at all: an operator could fill them in, see MAIL_HOST set,
     * and get no mail and no error - the quietest possible failure. They are
     * honoured now, with the older NOREPLYMAIL and ADMINMAIL kept as fallbacks
     * so existing deployments keep working untouched.
     */
    user:
      optional("MAIL_USER") || optional("NOREPLYMAIL") || optional("ADMINMAIL"),
    password:
      optional("MAIL_PASSWORD") ||
      optional("NOREPLYMAIL_PASSWORD") ||
      optional("ADMINMAIL_PASSWORD"),
    // The bold name an inbox shows in its own column. The company, not the
    // product - the product leads the subject line instead.
    fromName: optional("MAIL_FROM_NAME", "ServerPe App Solutions"),
    supportInbox: optional("SUPPORT_EMAIL", "support@mastipe.in"),
  },

  /** The marketing site, for links the bot hands out. */
  siteBaseUrl: SITE_BASE_URL,

  /**
   * Where the policies actually live.
   *
   * On the company's own domain whenever SITE_BASE_URL is set. A privacy
   * policy served from api.mastipe.in reads as somebody else's document, and
   * Meta, Razorpay and every regulator ask for a link on the brand's own
   * address. Falls back to this server's own copy so the link is never dead.
   */
  policiesUrl: (SITE_BASE_URL || PUBLIC_BASE_URL + API_BASE_PATH) + "/policies",

  /**
   * Where the admin panel is, for the button on every alert email.
   *
   * Optional: with nothing set the button is simply left out rather than
   * pointing at a dead localhost address in an email read on a phone.
   */
  adminUrl: optional("ADMIN_PANEL_URL", "") || null,

  /** How-to-play, which genuinely does live on the API - it is generated. */
  demoUrl: PUBLIC_BASE_URL + API_BASE_PATH + "/public/demo",

  /** Operator alerts. Every trigger's mode is set from the admin panel. */
  alerts: {
    enabled: optional("ADMIN_NOTIFICATIONS_ENABLED", "true") === "true",
    recipient: optional("ALERT_RECIPIENT") || optional("ADMINMAIL"),
    digestMinutes: int("ALERT_DIGEST_MINUTES", 10, { min: 1, max: 1440 }),
    // Hour (IST) after which the daily summary is sent.
    dailyHour: int("DAILY_SUMMARY_HOUR", 8, { min: 0, max: 23 }),
  },

  geo: {
    // Server-side IP lookup only - players are never asked for permission.
    enabled: optional("GEO_LOOKUP_ENABLED", "false") === "true",
    provider: optional("GEO_PROVIDER", "ip-api.com"),
    apiKey: optional("GEO_API_KEY"),
  },

  game: {
    drawIntervalSeconds: int("DRAW_INTERVAL_SECONDS", 12, { min: 3, max: 120 }),
    // A pre-roll after the host taps Start, so nobody is still opening their
    // board when the first number lands.
    startCountdownSeconds: int("START_COUNTDOWN_SECONDS", 5, {
      min: 3,
      max: 30,
    }),
    earlyAdvanceDelayMs: int("EARLY_ADVANCE_DELAY_MS", 300, {
      min: 0,
      max: 10000,
    }),
    minPlayers: int("MIN_PLAYERS_TO_START", 2, { min: 2, max: 50 }),
    maxPlayers: int("MAX_PLAYERS_PER_GAME", 50, { min: 2, max: 2000 }),
    lobbyExpiryMinutes: int("LOBBY_EXPIRY_MINUTES", 60, { min: 1, max: 1440 }),

    /**
     * Whether Tap Bakra is offered to players.
     *
     * The code default is ON, because the game works and a feature should not
     * be switched off by the absence of a variable. Taking it off the menu is
     * done through the admin panel, which stores `bakra_enabled` and overrides
     * this - so the decision travels with the database rather than needing a
     * matching .env on every machine. BAKRA_ENABLED is here for the case where
     * a deployment wants it off before it has a database to configure.
     */
    bakraEnabled: optional("BAKRA_ENABLED", "true") !== "false",
  },
};

if (problems.length) {
  console.error("\nConfiguration problems in .env:\n");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nSee .env.example for the full list of keys.\n");
  process.exit(1);
}
