/**
 * Sending the one-time sign-in code.
 *
 * ── Why this is its own module ─────────────────────────────────────────────
 *
 * Every Indian SMS provider wants something different - a DLT template id, a
 * sender id, a route, a JSON body or a URL path - and the choice of provider is
 * a business decision, not a code one. So the OTP logic never talks to a
 * provider directly; it calls sendOtp() and this file decides how.
 *
 * ── The log provider ───────────────────────────────────────────────────────
 *
 * SMS_PROVIDER=log writes the code to the server log instead of sending it,
 * which is how you sign in while developing. It is not a security hole - only
 * an operator can read the log - but on a real deployment it means NOBODY can
 * sign in, because the code never reaches their phone. So on anything that is
 * not a local or tunnelled URL it refuses outright, and the page says sign-in
 * is unavailable, rather than leaving people waiting for a message that is not
 * coming.
 */
import { config } from "../config/env.js";
import { log } from "../utils/logger.js";

export class SmsError extends Error {
  constructor(message, code = "sms_failed") {
    super(message);
    this.code = code;
  }
}

/** Local, or a tunnel to a local machine - somewhere a developer reads the log. */
function isDevelopmentUrl() {
  const url = String(config.publicBaseUrl || "");
  return /localhost|127\.0\.0\.1|ngrok|trycloudflare|\.local\b/i.test(url) || !url;
}

/** What the rest of the app can ask before offering web sign-in at all. */
export function smsReady() {
  const provider = config.otp.provider;
  if (provider === "log") {
    return isDevelopmentUrl() || config.otp.allowLogInProduction;
  }
  if (!PROVIDERS.has(provider) || !config.otp.apiKey) return false;
  // The DLT route cannot deliver without both of these, so "ready" would be
  // a lie. env.js refuses to boot in this state; this keeps the answer
  // correct even if that check is ever relaxed.
  if (provider === "fast2sms" && config.otp.route === "dlt") {
    return Boolean(config.otp.senderId && config.otp.templateId);
  }
  return true;
}

/**
 * +91 xxxxx xx415, for logs. The whole number never needs to be in one.
 *
 * The country code is whatever is left once the last ten digits are taken
 * off, rather than the first two characters - a ten-digit number has no code
 * at all, and the earlier version reported one anyway, printing +98 for a
 * number starting 98. A log that states the wrong country is worse than a log
 * that states none.
 */
function masked(phone) {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length < 4) return "(unusable number)";
  const local = digits.slice(-10);
  const cc = digits.length > 10 ? "+" + digits.slice(0, digits.length - 10) + " " : "";
  return cc + "xxxxx xx" + local.slice(-3);
}

/**
 * Fast2SMS wants a bare ten-digit Indian number.
 *
 * Everything inside this app carries the country code - normalisePhone()
 * produces 91XXXXXXXXXX - so it has to come off here rather than anywhere
 * upstream. Sending the 12-digit form is accepted by the API and then simply
 * never delivered, which is the worst kind of bug to find in production.
 */
function toLocalNumber(phone) {
  const digits = String(phone).replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

const FAST2SMS_URL = "https://www.fast2sms.com/dev/bulkV2";

/**
 * Fast2SMS, over the DLT route.
 *
 * ── Why the body looks like this ───────────────────────────────────────────
 *
 * On the dlt route `message` is NOT the text - it is the numeric id of the
 * template DLT approved, and `variables_values` fills its {#var#} slots in
 * order. The wording a player reads lives on the operator portal, not here,
 * and that is not a limitation to work around: India requires the text to be
 * registered before it can be delivered, so a message composed in code would
 * be rejected rather than sent.
 *
 * ── Why the response is checked this closely ───────────────────────────────
 *
 * Fast2SMS answers 200 OK with `{"return": false, ...}` for most failures -
 * no balance, unapproved template, bad sender id. Treating a 200 as success
 * would mean every one of those looked like a delivered code to the player,
 * who would then sit waiting for an SMS that was refused.
 */
async function sendViaFast2Sms(phone, code) {
  const route = config.otp.route;

  const body = {
    route,
    numbers: toLocalNumber(phone),
    flash: "0",
  };

  if (route === "dlt") {
    // `message` is the Message ID, not the text. Fast2SMS holds the approved
    // wording against it and substitutes variables_values into {#var#}.
    body.sender_id = config.otp.senderId;
    body.message = config.otp.templateId;
    body.variables_values = String(code);
  } else if (route === "dlt_manual") {
    // Here the wording travels with the request and has to match what DLT
    // approved, character for character, or the operator drops it silently.
    body.sender_id = config.otp.senderId;
    body.template_id = config.otp.templateId;
    body.entity_id = config.otp.entityId;
    body.message = String(config.otp.messageText).replaceAll("{#var#}", String(code));
  } else {
    // otp and q routes: Fast2SMS composes the text from its own template.
    body.variables_values = String(code);
  }

  let res;
  try {
    res = await fetch(FAST2SMS_URL, {
      method: "POST",
      headers: {
        authorization: config.otp.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      // A provider that hangs must not hold a player on a spinner. The route
      // answers in well under a second normally.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // Timeout, DNS, TLS - anything that means the request never got an answer.
    throw new Error(`fast2sms unreachable: ${err.message}`);
  }

  const text = await res.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    /* A gateway error page, not JSON. The raw text is what explains it. */
  }

  if (!res.ok || !payload || payload.return !== true) {
    const detail =
      (payload && (Array.isArray(payload.message) ? payload.message.join("; ") : payload.message)) ||
      text.slice(0, 200);
    throw new Error(`fast2sms refused (${res.status}): ${detail}`);
  }

  log.info("OTP sent by SMS", {
    provider: "fast2sms",
    to: masked(phone),
    requestId: payload.request_id ?? null,
  });
}

/**
 * The providers that are actually wired.
 *
 * `log` writes the code to the server log; `fast2sms` sends it. Nothing is
 * added here speculatively - a provider in this map has been run against real
 * keys, so a name present is a name that works.
 */
const PROVIDERS = new Map([
  ["log", async (phone, code) => {
    log.warn("OTP (log provider - not sent by SMS)", { to: masked(phone), code });
  }],
  ["fast2sms", sendViaFast2Sms],
]);

/**
 * Whether this number may be sent to at all.
 *
 * Empty list means no restriction, exactly as the WhatsApp client behaves. A
 * non-empty list means ONLY those numbers - the standing rule on this project
 * - and a blocked send logs the code instead of silently vanishing, so a
 * developer can still complete a sign-in while testing.
 */
function allowed(phone) {
  const list = config.otp.allowedRecipients;
  if (!list.length) return true;
  const digits = String(phone).replace(/\D/g, "");
  return list.some((entry) => {
    const e = String(entry).replace(/\D/g, "");
    return e === digits || e === toLocalNumber(digits) || toLocalNumber(e) === toLocalNumber(digits);
  });
}

/**
 * Sends one code to one number.
 *
 * Throws SmsError with a message safe to show a player. The underlying
 * provider error goes to the log, never to the page.
 */
export async function sendOtp(phone, code) {
  const provider = config.otp.provider;

  if (!smsReady()) {
    log.error("web sign-in attempted but SMS is not configured", {
      provider,
      hint: provider === "log"
        ? "SMS_PROVIDER=log only works on a local or tunnelled URL"
        : "set SMS_API_KEY for this provider",
    });
    throw new SmsError(
      "Sign-in by mobile is not available right now. Please try again later.",
      "sms_unavailable",
    );
  }

  const send = PROVIDERS.get(provider);
  if (!send) {
    log.error("unknown SMS_PROVIDER", { provider });
    throw new SmsError("Sign-in by mobile is not available right now.", "sms_unavailable");
  }

  // Checked here rather than inside each provider, so adding a provider later
  // cannot accidentally bypass it.
  if (!allowed(phone)) {
    log.warn("SMS NOT sent - number is not on the allowlist", {
      to: masked(phone),
      allowlist: config.otp.allowedRecipients.length + " entries",
      code,
      hint: "SMS_ALLOWED_RECIPIENTS (or WHATSAPP_ALLOWED_RECIPIENTS) restricts outbound SMS. Clear it to send to anyone.",
    });
    return;
  }

  try {
    await send(phone, code);
  } catch (err) {
    log.error("SMS send failed", { provider, to: masked(phone), message: err.message });
    throw new SmsError("We could not send the code. Please try again in a moment.");
  }
}
