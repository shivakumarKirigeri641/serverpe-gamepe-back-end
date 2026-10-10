/**
 * Web sign-in: a mobile number, a one-time code, and a session.
 *
 * ── The number is the identity ────────────────────────────────────────────
 *
 * A verified number is stored in players.wa_id, exactly where WhatsApp stores
 * the same number. So somebody who played over WhatsApp and later signs in on
 * the web is the same player, with the same history and the same stats. They
 * proved they hold the number, which is precisely what WhatsApp proved.
 *
 * This is also what stops one person taking several seats. The anonymous web
 * flow minted a new player on every host and every join, so tapping an invite
 * twice seated the same person twice. With a stable identity, joinGame sees a
 * player it already knows and returns the seat they have.
 *
 * ── What is stored ────────────────────────────────────────────────────────
 *
 * Neither the code nor the session token is ever written down. Both are hashed
 * on the way in, so a copy of the database is not a way to sign in as anyone.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { query, withTransaction } from "../db/pool.js";
import { config } from "../config/env.js";
import { log } from "../utils/logger.js";
import { sendOtp, SmsError } from "./sms.service.js";
import { POLICY_VERSION, recordConsent, hasConsented } from "./player.service.js";

export class AuthError extends Error {
  constructor(message, { status = 400, code = "auth_error", retryAfterSeconds = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * An Indian mobile number, as WhatsApp would write it: 91 then ten digits.
 *
 * Accepts the ways people actually type one - with or without +91, with a
 * leading 0, with spaces and dashes. India only for now; a foreign number is
 * refused rather than guessed at, because a wrongly normalised number sends a
 * code to a stranger.
 */
export function normalisePhone(input) {
  let d = String(input ?? "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10) d = "91" + d;
  if (!/^91[6-9]\d{9}$/.test(d)) return null;
  return d;
}

const masked = (phone) => String(phone).replace(/^(\d{2})\d+(\d{3})$/, "+$1 xxxxx xx$2");

/** Bound to the number, so a code cannot be replayed against a different one. */
function hashCode(phone, code) {
  return createHmac("sha256", "otp:" + config.boardLinkSecret)
    .update(phone + ":" + code)
    .digest("hex");
}

/**
 * The standing code for this number, if one is configured, else null.
 *
 * Set through OTP_FIXED_CODES so it is never committed. Read on every call
 * rather than captured at import, so the answer always reflects the current
 * configuration rather than whatever was true when the process booted.
 */
function fixedCodeFor(phone) {
  const map = config.otp.fixedCodes;
  if (!map || map.size === 0) return null;
  const digits = String(phone ?? "").replace(/\D/g, "");
  // Accept the number written with or without the country code, because a
  // human editing .env will write whichever one they are thinking of.
  return map.get(digits) ?? map.get(digits.slice(-10)) ?? map.get("91" + digits.slice(-10)) ?? null;
}

const hashToken = (token) => createHash("sha256").update(token).digest("hex");

/* ── asking for a code ─────────────────────────────────────────────────── */

export async function requestOtp({ phone: raw, ip }) {
  const phone = normalisePhone(raw);
  if (!phone) {
    throw new AuthError("Enter a valid 10-digit Indian mobile number.", { code: "bad_phone" });
  }

  const { rows: blocked } = await query("SELECT 1 FROM blocked_numbers WHERE wa_id = $1", [phone]);
  if (blocked.length) {
    // The same wording as any other refusal. Telling a blocked number that it
    // is blocked just invites it to try another.
    throw new AuthError("Sign-in is not available for this number.", { status: 403, code: "blocked" });
  }

  const o = config.otp;

  // All three limits read from the table rather than memory, so they hold
  // across a restart and across the time it takes somebody to notice a loop.
  const { rows: [recent] } = await query(
    `SELECT
       max(created_at) FILTER (WHERE phone = $1)                                          AS last_at,
       count(*) FILTER (WHERE phone = $1 AND created_at > now() - interval '1 hour')::int AS phone_hour,
       count(*) FILTER (WHERE request_ip = $2 AND created_at > now() - interval '1 hour')::int AS ip_hour
     FROM otp_requests
     WHERE (phone = $1 OR request_ip = $2) AND created_at > now() - interval '1 hour'`,
    [phone, ip ?? null],
  );

  if (recent.last_at) {
    const since = (Date.now() - new Date(recent.last_at).getTime()) / 1000;
    if (since < o.resendAfterSeconds) {
      const wait = Math.ceil(o.resendAfterSeconds - since);
      throw new AuthError(`Please wait ${wait} seconds before asking for another code.`, {
        status: 429, code: "too_soon", retryAfterSeconds: wait,
      });
    }
  }
  if (recent.phone_hour >= o.perPhonePerHour) {
    throw new AuthError("Too many codes for this number. Please try again in an hour.", {
      status: 429, code: "phone_limit", retryAfterSeconds: 3600,
    });
  }
  if (ip && recent.ip_hour >= o.perIpPerHour) {
    log.warn("OTP ip limit reached", { ip, count: recent.ip_hour });
    throw new AuthError("Too many sign-in attempts from this network. Please try again later.", {
      status: 429, code: "ip_limit", retryAfterSeconds: 3600,
    });
  }

  // Only the newest code is ever live. Without this, an older code left unused
  // (say, refused for a missing checkbox) came back to life the moment the
  // newer one was spent - two valid codes for one number, one of them in an
  // SMS the person had already stopped looking at.
  await query(
    "UPDATE otp_requests SET consumed_at = now() WHERE phone = $1 AND consumed_at IS NULL",
    [phone],
  );

  /*
   * A fixed code, for the operator's own number.
   *
   * Issued through the SAME path as a random one - inserted into
   * otp_requests, with the same expiry, the same single-use consumption and
   * the same wrong-guess limit. Only two things differ: the value is
   * predictable, and no SMS is sent. So nothing about the verification is
   * weakened; the code is simply one the owner already knows.
   */
  const fixed = fixedCodeFor(phone);
  const code = fixed ?? String(randomInt(0, 10 ** o.length)).padStart(o.length, "0");

  const { rows: [row] } = await query(
    `INSERT INTO otp_requests (phone, code_hash, expires_at, request_ip)
     VALUES ($1, $2, now() + make_interval(secs => $3), $4)
     RETURNING id`,
    [phone, hashCode(phone, code), o.ttlSeconds, ip ?? null],
  );

  if (fixed) {
    // WARN, not INFO: this is a standing exception and it should be visible
    // in the log every single time it is used, not something you have to go
    // looking for.
    log.warn("OTP fixed code issued - no SMS sent", {
      to: masked(phone),
      hint: "configured in OTP_FIXED_CODES; remove that line to disable",
    });
    /*
     * Deliberately indistinguishable from a real send.
     *
     * An earlier version returned `fixedCode: true` so the page could say
     * "use your usual code". That is a nicer message and a worse idea: anyone
     * may ask for a code on any number, so the flag let a stranger discover
     * WHICH numbers have a standing code - and a 4-digit code is a much
     * better target once you know it never changes. The operator knows their
     * own code; nobody else needs a hint that one exists.
     */
    return {
      sentTo: masked(phone),
      expiresInSeconds: o.ttlSeconds,
      resendAfterSeconds: o.resendAfterSeconds,
    };
  }

  try {
    await sendOtp(phone, code);
  } catch (err) {
    // A code that never left the building should not count against the
    // player's resend wait - they did nothing wrong.
    await query("DELETE FROM otp_requests WHERE id = $1", [row.id]);
    if (err instanceof SmsError) {
      throw new AuthError(err.message, { status: 503, code: err.code });
    }
    throw err;
  }

  log.info("OTP sent", { to: masked(phone) });
  return {
    sentTo: masked(phone),
    expiresInSeconds: o.ttlSeconds,
    resendAfterSeconds: o.resendAfterSeconds,
  };
}

/* ── checking a code ───────────────────────────────────────────────────── */

/**
 * Checks the code, then finds or creates the player and opens a session.
 *
 * `displayName` is required only the first time a number signs in - a player
 * who already has a name keeps it. `consent` is required whenever the player
 * has not yet agreed to the current policy version, which for a web sign-in is
 * every first visit and every visit after the terms change.
 */
export async function verifyOtp({
  phone: raw,
  code,
  displayName,
  consent,
  ip,
  userAgent,
  // The guest they were playing as, if any. Passed by the route from the
  // session token the page already holds - never from the request body,
  // which would let anyone claim somebody else's guest history.
  guestPlayerId = null,
}) {
  const phone = normalisePhone(raw);
  if (!phone) throw new AuthError("Enter a valid 10-digit Indian mobile number.", { code: "bad_phone" });

  const clean = String(code ?? "").replace(/\D/g, "");
  // A fixed code may be a different length from the configured one - 6416 is
  // four digits while OTP_LENGTH is six - so the expected length is per
  // number, not global. Without this the fixed code is rejected before it is
  // ever compared, which looks exactly like a wrong code.
  const expectedLength = (fixedCodeFor(phone) ?? "").length || config.otp.length;
  if (clean.length !== expectedLength) {
    throw new AuthError(`Enter the ${expectedLength}-digit code we sent you.`, { code: "bad_code" });
  }

  // Counting the attempt and reading the hash in one statement. Two guesses
  // sent in parallel each take a separate turn at the counter, so parallel
  // requests cannot buy more guesses than the limit allows.
  const { rows: [req] } = await query(
    `UPDATE otp_requests
        SET attempts = attempts + 1
      WHERE id = (
        SELECT id FROM otp_requests
         WHERE phone = $1 AND consumed_at IS NULL AND expires_at > now()
         ORDER BY created_at DESC
         LIMIT 1
      )
      RETURNING id, code_hash, attempts`,
    [phone],
  );

  if (!req) {
    throw new AuthError("That code has expired. Ask for a new one.", { code: "expired" });
  }
  if (req.attempts > config.otp.maxAttempts) {
    throw new AuthError("Too many wrong codes. Ask for a new one.", { status: 429, code: "locked" });
  }

  const a = Buffer.from(req.code_hash, "hex");
  const b = Buffer.from(hashCode(phone, clean), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    const left = config.otp.maxAttempts - req.attempts;
    throw new AuthError(
      left > 0 ? `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.`
               : "Too many wrong codes. Ask for a new one.",
      { status: left > 0 ? 400 : 429, code: left > 0 ? "wrong_code" : "locked" },
    );
  }

  /* What else this sign-in needs, decided BEFORE the code is spent.
     A correct code with the terms box left unticked used to be consumed on
     the way to the refusal - so the person had to wait out the resend timer
     and read a new SMS, for a checkbox. Now the code survives until everything
     it needs is present, and the attempt it cost is handed back: only a WRONG
     code should count against the limit. */
  const name = String(displayName ?? "").trim().replace(/\s+/g, " ").slice(0, 40) || null;
  let { rows: [player] } = await query("SELECT * FROM players WHERE wa_id = $1", [phone]);

  if (player?.is_blocked) {
    throw new AuthError("Sign-in is not available for this number.", { status: 403, code: "blocked" });
  }

  /*
   * A guest already told us their name when they joined, so asking again on
   * the way to a number is asking twice for the same thing - and it refused
   * the sign-in outright when the page (correctly) did not resend it.
   */
  let guestName = null;
  if (guestPlayerId) {
    const { rows: [g] } = await query(
      "SELECT display_name FROM players WHERE id = $1 AND wa_id LIKE 'guest:%'",
      [guestPlayerId],
    );
    guestName = g?.display_name ?? null;
  }

  let missing = null;
  if (!player && !name && !guestName) {
    missing = ["name_required", "Tell us your name - it is what the other players will see."];
  }
  else if (consent !== true && (!player || !(await hasConsented(player.id, POLICY_VERSION)))) {
    missing = ["consent_required", "Please accept the terms to continue."];
  }
  if (missing) {
    await query("UPDATE otp_requests SET attempts = greatest(attempts - 1, 0) WHERE id = $1", [req.id]);
    throw new AuthError(missing[1], { code: missing[0] });
  }

  // Spent exactly once. Two tabs submitting the same correct code cannot both
  // come away with a session.
  const { rowCount } = await query(
    "UPDATE otp_requests SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL",
    [req.id],
  );
  if (!rowCount) throw new AuthError("That code has already been used. Ask for a new one.", { code: "used" });

  /* the player */
  let isNew = false;

  /*
   * Were they playing as a guest a moment ago?
   *
   * If so, that guest row becomes this number's player - so the games they
   * just played follow them in. Without this, signing in would LOSE their
   * history, which makes giving us a number a punishment rather than an
   * upgrade, and nobody would do it twice.
   */
  if (!player && guestPlayerId) {
    const promoted = await promoteGuest({ guestPlayerId, phone, name });
    if (promoted) {
      player = promoted.player;
      isNew = !promoted.merged;
    }
  } else if (player && guestPlayerId && Number(guestPlayerId) !== Number(player.id)) {
    // They have an account AND a guest session. Fold the guest into it.
    const promoted = await promoteGuest({ guestPlayerId, phone, name });
    if (promoted) player = promoted.player;
  }

  if (!player) {
    ({ rows: [player] } = await query(
      `INSERT INTO players (wa_id, display_name, channel)
       VALUES ($1, $2, 'web')
       ON CONFLICT (wa_id) DO UPDATE SET last_seen_at = now()
       RETURNING *`,
      [phone, name],
    ));
    isNew = true;
  } else if (!player.display_name && name) {
    // An existing player (usually from WhatsApp) who never had a name set.
    ({ rows: [player] } = await query(
      "UPDATE players SET display_name = $2, last_seen_at = now() WHERE id = $1 RETURNING *",
      [player.id, name],
    ));
  } else {
    await query("UPDATE players SET last_seen_at = now() WHERE id = $1", [player.id]);
  }

  // Consent is an act, not an assumption. A player who already agreed to this
  // version - over WhatsApp or on an earlier visit - is not asked again; one
  // who has not ticked the box never gets this far (checked above).
  if (!(await hasConsented(player.id, POLICY_VERSION))) {
    await recordConsent(player.id, POLICY_VERSION, "web");
  }

  const token = randomBytes(32).toString("base64url");
  await query(
    `INSERT INTO player_sessions (token_hash, player_id, request_ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))`,
    [hashToken(token), player.id, ip ?? null, String(userAgent ?? "").slice(0, 300) || null, config.otp.sessionDays],
  );

  log.info("web sign-in", { playerId: player.id, to: masked(phone), isNew });
  return { token, player: publicPlayer(player), isNew };
}

/* ── guests ────────────────────────────────────────────────────────────── */

/**
 * The prefix that marks a player who has not given a number.
 *
 * `wa_id` is NOT NULL and UNIQUE, and it is the identity column everything
 * else joins on, so a guest needs a value there. A namespaced synthetic one
 * keeps guests inside the single players table - which is what lets a guest
 * who signs in later become the same player rather than a second account.
 */
const GUEST_PREFIX = "guest:";

export const isGuest = (player) =>
  String(player?.wa_id ?? "").startsWith(GUEST_PREFIX);

/**
 * A player with a name and nothing else.
 *
 * ── Why guests exist ─────────────────────────────────────────────────────
 *
 * Every player arrives through a link a host shared, and they arrive at the
 * worst possible moment to be asked for a phone number: the host has just
 * shared the link, people are gathering, the game is about to start. Six
 * people each leaving for their SMS app is how a room ends up half empty on
 * the one occasion that decides whether a group ever plays again.
 *
 * So a joiner gives a name. The HOST still signs in properly - they are the
 * organiser, the repeat visitor, the number actually worth having, and
 * requiring it of them also means a stranger cannot spam rooms into
 * existence.
 *
 * ── One identity per device, not per request ─────────────────────────────
 *
 * The token goes in localStorage and is reused. An earlier version of this
 * idea minted an identity per REQUEST and three taps on one invite produced
 * three players holding three tickets. The caller passes back the session it
 * already has, and an existing guest session is returned untouched rather
 * than replaced.
 */
export async function createGuest({ displayName, consent, ip, userAgent } = {}) {
  const name = String(displayName ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
  if (name.length < 2) {
    throw new AuthError("Tell us your name - it is what the other players will see.", {
      code: "name_required",
    });
  }
  // Consent is a legal requirement, not an account feature. A guest ticks the
  // same box a member does.
  if (consent !== true) {
    throw new AuthError("Please accept the terms to continue.", { code: "consent_required" });
  }

  const waId = GUEST_PREFIX + randomBytes(12).toString("base64url");
  const { rows: [player] } = await query(
    `INSERT INTO players (wa_id, display_name, channel)
     VALUES ($1, $2, 'web')
     RETURNING *`,
    [waId, name],
  );

  await recordConsent(player.id, POLICY_VERSION, "web");

  const token = randomBytes(32).toString("base64url");
  await query(
    `INSERT INTO player_sessions (token_hash, player_id, request_ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))`,
    [hashToken(token), player.id, ip ?? null, String(userAgent ?? "").slice(0, 300) || null, config.otp.sessionDays],
  );

  log.info("guest created", { playerId: player.id, name });
  return { token, player: publicPlayer(player), isNew: true, guest: true };
}

/**
 * A guest who has now given a number becomes that number's player.
 *
 * Two cases, and getting the second one wrong is how somebody loses their
 * history for the crime of signing in:
 *
 *   the number is new    rename the guest row. Nothing to move, and every
 *                        game, ticket and claim already points at this id.
 *
 *   the number exists    the person already has an account (they hosted once,
 *                        or played before). Re-point the guest's rows at it
 *                        and retire the guest.
 *
 * Done in one transaction: a half-merged player would hold a ticket in a game
 * under one id and a claim under another.
 */
export async function promoteGuest({ guestPlayerId, phone, name }) {
  return withTransaction(async (client) => {
    const { rows: [guest] } = await client.query(
      "SELECT * FROM players WHERE id = $1 FOR UPDATE",
      [guestPlayerId],
    );
    if (!guest || !String(guest.wa_id).startsWith(GUEST_PREFIX)) return null;

    const { rows: [existing] } = await client.query(
      "SELECT * FROM players WHERE wa_id = $1 FOR UPDATE",
      [phone],
    );

    if (!existing) {
      const { rows: [promoted] } = await client.query(
        `UPDATE players
            SET wa_id = $2,
                display_name = coalesce(display_name, $3),
                last_seen_at = now()
          WHERE id = $1
        RETURNING *`,
        [guest.id, phone, name ?? null],
      );
      log.info("guest promoted in place", { playerId: guest.id });
      return { player: promoted, merged: false };
    }

    // Move what the guest did onto the real player. ON CONFLICT DO NOTHING on
    // game_players: if they somehow hold both seats in one game, keep the one
    // that is already there rather than failing the whole merge.
    for (const sql of [
      `UPDATE game_players SET player_id = $2 WHERE player_id = $1
         AND NOT EXISTS (SELECT 1 FROM game_players g2
                          WHERE g2.game_id = game_players.game_id AND g2.player_id = $2)`,
      `UPDATE entries        SET player_id = $2 WHERE player_id = $1`,
      `UPDATE draw_answers   SET player_id = $2 WHERE player_id = $1`,
      `UPDATE claims         SET player_id = $2 WHERE player_id = $1`,
      `UPDATE board_sessions SET player_id = $2 WHERE player_id = $1`,
      `UPDATE analytics_events SET player_id = $2 WHERE player_id = $1`,
    ]) {
      await client.query(sql, [guest.id, existing.id]);
    }

    // Any seat that could not be moved belonged to a game the real player was
    // already in, so the guest row has nothing left worth keeping.
    await client.query("DELETE FROM players WHERE id = $1", [guest.id]);
    await client.query("UPDATE players SET last_seen_at = now() WHERE id = $1", [existing.id]);

    log.info("guest merged into existing player", { guestId: guest.id, playerId: existing.id });
    return { player: existing, merged: true };
  });
}

/* ── sessions ──────────────────────────────────────────────────────────── */

/** What the page is allowed to know about the signed-in player. */
export function publicPlayer(p) {
  return {
    id: Number(p.id),
    name: p.display_name || null,
    // A guest has no number, and `masked` on a synthetic id would produce
    // something that looks like one. Null says "not given" honestly.
    phone: isGuest(p) ? null : masked(p.wa_id),
    channel: p.channel || "whatsapp",
    guest: isGuest(p),
  };
}

export async function resolvePlayerSession(token) {
  if (!token) return null;
  const { rows: [row] } = await query(
    `SELECT s.id AS session_id, s.last_used_at, p.*
       FROM player_sessions s
       JOIN players p ON p.id = s.player_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [hashToken(token)],
  );
  if (!row) return null;
  if (row.is_blocked) return null;

  // Touched at most every five minutes. A write on every request would turn
  // an ordinary page into a stream of updates to the same row.
  if (Date.now() - new Date(row.last_used_at).getTime() > 5 * 60 * 1000) {
    await query("UPDATE player_sessions SET last_used_at = now() WHERE id = $1", [row.session_id]);
  }
  return row;
}

export async function revokePlayerSession(token) {
  if (!token) return;
  await query(
    "UPDATE player_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
    [hashToken(token)],
  );
}

const bearer = (req) => {
  const h = req.get("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
};

/** Express middleware: a signed-in player, or 401. */
export function requirePlayer() {
  return async (req, res, next) => {
    try {
      const player = await resolvePlayerSession(bearer(req));
      if (!player) {
        return res.status(401).json({ error: "Please sign in again.", code: "signed_out" });
      }
      req.player = player;
      req.playerToken = bearer(req);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * A player row, but only a VERIFIED one. Guests are turned away.
 *
 * Used for hosting. A host is the organiser and the repeat visitor, so their
 * number is the one actually worth having - and requiring it is also what
 * stops a stranger spawning rooms by the hundred, since a guest identity
 * costs nothing to mint.
 */
export function requireVerifiedPlayer() {
  return async (req, res, next) => {
    try {
      const player = await resolvePlayerSession(bearer(req));
      if (!player) {
        return res.status(401).json({ error: "Please sign in again.", code: "signed_out" });
      }
      if (isGuest(player)) {
        return res.status(403).json({
          error: "Add your mobile number to host a game. Your name and games stay as they are.",
          code: "verification_required",
        });
      }
      req.player = player;
      req.playerToken = bearer(req);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Resolves a session if there is one, and never refuses.
 *
 * For routes that are open to anybody but behave differently when the caller
 * already has an identity - sign-in being the one that matters, where an
 * existing guest session is what lets their games follow them in.
 */
export function attachPlayer() {
  return async (req, _res, next) => {
    try {
      const player = await resolvePlayerSession(bearer(req));
      if (player) {
        req.player = player;
        req.playerToken = bearer(req);
        if (isGuest(player)) req.guestPlayerId = player.id;
      }
    } catch {
      /* an unreadable token is simply no identity */
    }
    next();
  };
}
