/**
 * The web journey, step by step, with an email at each one.
 *
 * ── The problem this solves ───────────────────────────────────────────────
 *
 * A Status ad sends somebody to the play page. Between that tap and a game
 * actually starting there are six places they can quietly give up, and the
 * server only ever saw the ones that happened to be API calls. So "nobody
 * played tonight" was all we could say - never *where* they stopped.
 *
 *   landed        opened the play page (the ad worked)
 *   phone_entered typed a mobile number
 *   code_sent     asked for a code          <- server-side
 *   code_entered  typed a code in
 *   signed_in     the code was right        <- server-side
 *   hosted        created a room            <- server-side
 *   joined        took a seat in a room     <- server-side
 *   started       the first number was called
 *
 * The four client-side ones arrive through POST /public/play/track, because
 * no request reaches the server when somebody types into a box and stops.
 *
 * ── Two destinations, one call ────────────────────────────────────────────
 *
 * Every step is written to analytics_events (so the funnel, the timeline and
 * the live page can read it) AND handed to notify(), which is the existing
 * alert system - already switchable per trigger between off, instant and the
 * ten-minute digest, from the admin panel, with device and location lines
 * attached for free.
 *
 * Nothing here is allowed to throw. A failed alert must never cost somebody
 * their sign-in, and a tracking beacon is the least important thing in any
 * request it rides along with.
 */
import { query } from "../db/pool.js";
import { log } from "../utils/logger.js";
import { requestInfo, describeClient } from "../utils/request-info.js";
import { notify } from "./notification.service.js";

/**
 * The steps a browser is allowed to report.
 *
 * A whitelist, not free text: this endpoint is open to anyone with the URL,
 * and an unbounded `step` would let a stranger write arbitrary rows into the
 * analytics table and arbitrary subject lines into your inbox.
 */
export const CLIENT_STEPS = new Map([
  ["landed", { event: "web.landed", trigger: "web.landed", words: "opened the play page" }],
  ["phone_entered", { event: "web.phone_entered", trigger: "web.phone_entered", words: "typed a mobile number" }],
  ["code_entered", { event: "web.code_entered", trigger: "web.code_entered", words: "typed in a code" }],
  ["abandoned", { event: "web.abandoned", trigger: "web.abandoned", words: "left without finishing" }],
]);

/** Steps the server raises itself, where it already knows what happened. */
const SERVER_STEPS = new Map([
  ["code_sent", { event: "web.code_sent", trigger: "web.code_sent", words: "asked for a sign-in code" }],
  ["signed_in", { event: "web.signed_in", trigger: "web.signed_in", words: "signed in" }],
  ["hosted", { event: "web.hosted", trigger: "web.hosted", words: "created a room" }],
  ["joined", { event: "web.joined", trigger: "web.joined", words: "joined a room" }],
  ["guest_joined", { event: "web.guest_joined", trigger: "web.guest_joined", words: "started playing as a guest" }],
]);

const STEPS = new Map([...CLIENT_STEPS, ...SERVER_STEPS]);

/** +91 xxxxx xx415 — enough for you to recognise, useless to anyone else. */
function masked(phone) {
  const d = String(phone ?? "").replace(/\D/g, "");
  if (d.length < 4) return null;
  const local = d.slice(-10);
  const cc = d.length > 10 ? "+" + d.slice(0, d.length - 10) + " " : "";
  return cc + "xxxxx xx" + local.slice(-3);
}

/**
 * Record one step and tell the operator.
 *
 * @param {object}  o
 * @param {string}  o.step      a key from STEPS
 * @param {object}  o.req       the Express request, for device/IP/location
 * @param {number?} o.playerId  once known
 * @param {number?} o.gameId    once known
 * @param {string?} o.phone     only ever stored masked
 * @param {object}  o.extra     anything else worth putting in the email
 */
export async function recordStep({
  step,
  req = null,
  playerId = null,
  gameId = null,
  phone = null,
  extra = {},
} = {}) {
  const spec = STEPS.get(String(step));
  if (!spec) {
    log.warn("unknown journey step ignored", { step });
    return;
  }

  const info = req ? requestInfo(req) : null;

  try {
    await query(
      `INSERT INTO analytics_events (event_type, source, player_id, game_id, request_ip, user_agent, properties)
       VALUES ($1, 'web', $2, $3, $4, $5, $6::jsonb)`,
      [
        spec.event,
        playerId,
        gameId,
        info?.ip ?? null,
        info?.userAgent ?? null,
        JSON.stringify({
          step,
          ...(phone ? { phone: masked(phone) } : {}),
          ...(info
            ? {
                device: info.deviceType ?? null,
                os: [info.os, info.osVersion].filter(Boolean).join(" ") || null,
                browser: [info.browser, info.browserVersion].filter(Boolean).join(" ") || null,
                // Whether they are inside another app's browser - a WhatsApp
                // Status ad opens in WhatsApp's own webview, and that is worth
                // knowing because it suspends backgrounded pages.
                inApp: info.isInAppBrowser ? (info.inAppHost ?? true) : false,
                language: info.language ?? null,
                referer: info.referer ?? null,
              }
            : {}),
          ...extra,
        }),
      ],
    );
  } catch (err) {
    // An analytics write must never be the reason a player cannot sign in.
    log.error("journey step not recorded", { step, message: err.message });
  }

  // The alert. Fire-and-forget: notify() already swallows its own failures,
  // and this is deliberately not awaited by the caller's critical path.
  const lines = [];
  if (phone) lines.push(`Number: ${masked(phone)}`);
  if (info) {
    const client = describeClient(info);
    if (client) lines.push(`Device: ${client}`);
    if (info.referer) lines.push(`Came from: ${info.referer}`);
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v !== null && v !== undefined && v !== "") lines.push(`${k}: ${v}`);
  }

  notify(spec.trigger, {
    title: `Someone ${spec.words}`,
    lines,
    playerId,
    gameId,
  }).catch(() => {
    /* notify() logs its own failures; never let one reach the player */
  });
}

/** True when a browser may report this step. */
export const isClientStep = (step) => CLIENT_STEPS.has(String(step));
