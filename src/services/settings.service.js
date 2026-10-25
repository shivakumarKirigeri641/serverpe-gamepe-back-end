/**
 * Settings an operator can change from the panel, without a redeploy.
 *
 * Each one falls back to its .env variable when nothing is stored, so a fresh
 * database behaves exactly as the environment describes and there is only ever
 * one answer to "what is this set to".
 *
 * The effective values are cached in memory because they are read on paths
 * that cannot be async - the WhatsApp copy builder, for one - and they change
 * about once a month. Every write refreshes the cache immediately, so the
 * panel never shows a value it just replaced.
 */
import { query } from "../db/pool.js";
import { config } from "../config/env.js";
import { log } from "../utils/logger.js";

export const KEYS = {
  TRIAL_ENDS_AT: "free_trial_ends_at",
  MAINTENANCE: "maintenance",
  PLAY_CHANNEL_MODE: "play_channel_mode",
  BAKRA_ENABLED: "bakra_enabled",
  CRICKET_ENABLED: "cricket_enabled",
};

const cache = new Map();

/** Reads every stored setting into the cache. Called once at boot. */
export async function loadSettings() {
  try {
    const { rows } = await query(
      "SELECT key, value, updated_at, updated_by FROM app_settings",
    );
    cache.clear();
    for (const r of rows) cache.set(r.key, r);
    log.info("settings loaded", { stored: rows.length });
  } catch (err) {
    // A missing table must not stop the server booting - the env defaults are
    // a complete configuration on their own.
    log.warn("could not load app_settings, using .env defaults", {
      message: err.message,
    });
  }
}

export async function setSetting(key, value, updatedBy = "admin") {
  if (value === null || value === undefined) {
    await query("DELETE FROM app_settings WHERE key = $1", [key]);
    cache.delete(key);
    log.info("setting reset to the .env default", { key, by: updatedBy });
    return;
  }
  const { rows } = await query(
    `INSERT INTO app_settings (key, value, updated_by)
          VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
      RETURNING key, value, updated_at, updated_by`,
    [key, String(value), updatedBy],
  );
  cache.set(key, rows[0]);
  log.info("setting saved", { key, value, by: updatedBy });
}

/** The value in force right now: stored if present, otherwise the .env one. */
export function effective(key, envFallback) {
  return cache.get(key)?.value ?? envFallback;
}

export function meta(key) {
  const row = cache.get(key);
  return {
    source: row ? "database" : "environment",
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  };
}

// --- Free trial ------------------------------------------------------------

export function trialEndsAt() {
  return effective(KEYS.TRIAL_ENDS_AT, config.freeTrialEndsAt);
}

/**
 * @param {string|null} endsAt ISO timestamp, or null to fall back to .env
 */
export async function setTrialEndsAt(endsAt, updatedBy) {
  if (endsAt !== null) {
    const when = new Date(endsAt);
    if (Number.isNaN(when.getTime())) {
      throw new Error(`"${endsAt}" is not a date we can read`);
    }
    endsAt = when.toISOString();
  }
  await setSetting(KEYS.TRIAL_ENDS_AT, endsAt, updatedBy);
  return trialState();
}

// --- Maintenance window ----------------------------------------------------

/**
 * Planned downtime, announced everywhere at once.
 *
 * Two independent switches, because they answer different questions:
 *
 *   enabled  - "there IS a maintenance window", set in advance
 *   force    - "we are down RIGHT NOW", regardless of the clock
 *
 * A window that has not started yet is announced but does not block anything,
 * so players get warned before it bites. `force` exists for the case the
 * window was wrong or something broke unexpectedly.
 */
const MAINTENANCE_DEFAULT = {
  enabled: false,
  force: false,
  from: null,
  to: null,
  message: "",
};

export function maintenance() {
  let stored = MAINTENANCE_DEFAULT;
  const raw = effective(KEYS.MAINTENANCE, null);
  if (raw) {
    try {
      stored = { ...MAINTENANCE_DEFAULT, ...JSON.parse(raw) };
    } catch {
      /* a corrupt value must never take the bot down */
    }
  }

  const now = Date.now();
  const from = stored.from ? new Date(stored.from).getTime() : null;
  const to = stored.to ? new Date(stored.to).getTime() : null;

  // No window at all means "as soon as it is enabled"; an open-ended window
  // means "from then until we say otherwise".
  const started = from === null || now >= from;
  const ended = to !== null && now > to;

  const active = stored.force || (stored.enabled && started && !ended);
  const upcoming =
    stored.enabled && !stored.force && from !== null && now < from;

  return {
    ...stored,
    active,
    upcoming,
    // Reported so a banner can say "back in 40 minutes" rather than "later".
    endsInMinutes:
      active && to ? Math.max(0, Math.ceil((to - now) / 60_000)) : null,
    startsInMinutes: upcoming
      ? Math.max(0, Math.ceil((from - now) / 60_000))
      : null,
    ...meta(KEYS.MAINTENANCE),
  };
}

export async function setMaintenance(patch, updatedBy) {
  const current = maintenance();
  const next = {
    enabled: patch.enabled ?? current.enabled,
    force: patch.force ?? current.force,
    from: patch.from === undefined ? current.from : patch.from,
    to: patch.to === undefined ? current.to : patch.to,
    message:
      patch.message === undefined
        ? current.message
        : String(patch.message).slice(0, 600),
  };

  for (const key of ["from", "to"]) {
    if (next[key]) {
      const when = new Date(next[key]);
      if (Number.isNaN(when.getTime()))
        throw new Error(`"${next[key]}" is not a date we can read`);
      next[key] = when.toISOString();
    }
  }
  if (next.from && next.to && new Date(next.to) <= new Date(next.from)) {
    throw new Error("The window must end after it starts");
  }

  await setSetting(KEYS.MAINTENANCE, JSON.stringify(next), updatedBy);
  return maintenance();
}

/** Everything the trial screen and the WhatsApp plan card need. */
export function trialState() {
  const endsAt = trialEndsAt();
  const daysLeft = Math.ceil(
    (new Date(endsAt).getTime() - Date.now()) / 86_400_000,
  );
  return {
    freeTrialEndsAt: endsAt,
    environmentDefault: config.freeTrialEndsAt,
    daysRemaining: daysLeft,
    isOver: daysLeft <= 0,
    monetizationEnabled: false,
    ...meta(KEYS.TRIAL_ENDS_AT),
  };
}

// --- Play channel ----------------------------------------------------------

const PLAY_CHANNELS = new Set(["whatsapp", "web", "hybrid"]);

export function playChannelMode() {
  const raw = String(
    effective(KEYS.PLAY_CHANNEL_MODE, config.playChannelMode || "whatsapp"),
  ).toLowerCase();
  return PLAY_CHANNELS.has(raw) ? raw : "whatsapp";
}

export function playChannel() {
  const mode = playChannelMode();
  return {
    mode,
    whatsappEnabled: mode !== "web",
    webEnabled: mode !== "whatsapp",
    ...meta(KEYS.PLAY_CHANNEL_MODE),
  };
}

export async function setPlayChannelMode(mode, updatedBy) {
  const next = String(mode ?? "").toLowerCase();
  if (!PLAY_CHANNELS.has(next)) {
    throw new Error("Play channel mode must be whatsapp, web or hybrid");
  }
  await setSetting(KEYS.PLAY_CHANNEL_MODE, next, updatedBy);
  return playChannel();
}

// --- Which games are on offer ----------------------------------------------

/*
 * Whether Tap Bakra is offered to players.
 *
 * A SETTING rather than deleted code, for the same reason the play channel is
 * one: taking a game off the menu is a decision that gets reversed, and the
 * reversal should be one click in the panel rather than a commit and a
 * deploy. Everything about the game stays built, tested and reachable.
 *
 * What this switch does NOT do is break links that are already out there.
 * /fatafat/:token stays mounted, so a round somebody was sent yesterday still
 * opens; what disappears is every entrance that would start a new one. A
 * player mid-round is not the right person to pay for a product decision.
 *
 * The admin panel's Tap Bakra screens are also untouched: hiding a game from
 * players is not hiding it from the operator, and the history has to stay
 * readable for as long as the rows exist.
 */
export function bakraEnabled() {
  const raw = effective(KEYS.BAKRA_ENABLED, config.game.bakraEnabled ? "true" : "false");
  return String(raw) === "true";
}

/** Whether Hand Cricket is offered to players. The same switch shape as Tap Bakra's, for the same reasons. */
export function cricketEnabled() {
  const raw = effective(KEYS.CRICKET_ENABLED, config.game.cricketEnabled ? "true" : "false");
  return String(raw) === "true";
}

/** Everything a page or an API response needs to decide what to show. */
export function gameVisibility() {
  const channel = playChannel();
  return {
    tambola: true,
    bakra: bakraEnabled(),
    cricket: cricketEnabled(),
    channel: channel.mode,
    ...meta(KEYS.BAKRA_ENABLED),
    cricketMeta: meta(KEYS.CRICKET_ENABLED),
  };
}

/**
 * Switch the side games on or off from the panel. Only the keys sent are
 * changed, and only to a real boolean - Boolean("false") is true.
 */
export async function setGamesEnabled({ bakra, cricket } = {}, updatedBy) {
  const flag = (v) => (v === true || v === "true" ? true : v === false || v === "false" ? false : null);
  if (bakra !== undefined) {
    const v = flag(bakra);
    if (v === null) throw new Error("Tap Bakra visibility must be true or false");
    await setSetting(KEYS.BAKRA_ENABLED, v ? "true" : "false", updatedBy);
  }
  if (cricket !== undefined) {
    const v = flag(cricket);
    if (v === null) throw new Error("Hand Cricket visibility must be true or false");
    await setSetting(KEYS.CRICKET_ENABLED, v ? "true" : "false", updatedBy);
  }
  return gameVisibility();
}

export async function setBakraEnabled(enabled, updatedBy) {
  // Only a real boolean, and only from the two spellings an API or a form
  // actually sends. Anything else would quietly enable the game, because
  // Boolean("false") is true.
  const next =
    enabled === true || enabled === "true"
      ? true
      : enabled === false || enabled === "false"
        ? false
        : null;
  if (next === null) throw new Error("Tap Bakra visibility must be true or false");

  await setSetting(KEYS.BAKRA_ENABLED, next ? "true" : "false", updatedBy);
  return gameVisibility();
}
