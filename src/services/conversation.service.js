/**
 * The WhatsApp conversation, as a state machine.
 *
 * WhatsApp is the front door: greeting, consent, the menu, choosing a player
 * count, and handing out board links. Nothing time-sensitive happens here -
 * the moment a player is seated, the game itself moves to the browser.
 *
 * Each player's position is a row in player_states, so a restart mid-flow
 * loses nothing.
 */
import { config } from '../config/env.js';
import { query } from '../db/pool.js';
import { log } from '../utils/logger.js';
import { boardUrl, inviteUrl, looksLikeRoomCode, normaliseRoomCode } from '../utils/code.js';
import { sendText, sendButtons, sendCtaUrl, sendList } from '../whatsapp/client.js';
import {
  copy, BUTTONS, OPTIONS, menuButtons, consentButtons, planButtons, optionsList,
} from './copy.js';
import {
  findOrCreatePlayer, getState, setState, hasConsented, recordConsent,
  logMessage, displayNameFor, getPlayerById,
} from './player.service.js';
import {
  createGame, joinGame, getGameByCode, findActiveGameForPlayer, leaveGame, GameError,
} from './game.service.js';
import { recordEvent } from './tracking.service.js';
import { STATES } from './conversation-states.js';
import { maintenance } from './settings.service.js';
import { broadcast } from './live.service.js';
import { FEEDBACK_BUTTONS, reportUrl, announceGameAbandoned } from './gameover.service.js';
import { saveRating, saveComment } from './feedback.service.js';
import {
  getTicketByReference, openTicketForPlayer, appendPlayerMessage,
} from './support.service.js';
import { feedbackUrl, supportUrl } from '../utils/code.js';

export { STATES } from './conversation-states.js';

const GREETINGS = /^(hi|hii+|hey|hello|start|menu|namaste|namaskar)\b/i;
const JOIN_COMMAND = /^join\s+([a-z0-9]{4,10})$/i;
/** Words a player actually uses when they want out. */
const LEAVE_COMMAND = /^(leave|quit|exit|stop)\b/i;
/** "status MP-AB12CD" - checking a ticket without opening a browser. */
const STATUS_COMMAND = /^status\s+([A-Za-z0-9-]{3,20})$/i;
const SUPPORT_COMMAND = /^(support|help)\b/i;

/**
 * Entry point for one inbound message. Never throws: a failure here would
 * leave the player staring at silence, so problems are logged and the player
 * is told something useful.
 */
export async function handleInbound(event) {
  const player = await findOrCreatePlayer(event.from, event.name);
  await logMessage({
    playerId: player.id,
    direction: 'in',
    waMessageId: event.waMessageId,
    kind: event.type,
    body: event.replyId ? `[${event.replyId}] ${event.text}` : event.text,
  });

  try {
    await route(player, event);
  } catch (err) {
    log.error('conversation handler failed', {
      waId: player.wa_id,
      type: event.type,
      replyId: event.replyId,
      message: err.message,
      stack: err.stack,
    });
    await sendText(player.wa_id, copy.unknown());
  }
}

async function route(player, event) {
  const state = await getState(player.id);

  // Maintenance takes precedence over everything a player could ask for -
  // except finishing a game that is already running, which is why this checks
  // for an active game rather than refusing outright.
  const window = maintenance();
  if (window.active) {
    const playing = await findActiveGameForPlayer(player.id);
    if (!playing || playing.status !== 'running') {
      return sendText(player.wa_id, copy.maintenance(window));
    }
  }

  // A JOIN link works from anywhere in the conversation - it is how invited
  // players arrive, and they should never have to navigate a menu first.
  const joinMatch = event.type === 'text' && event.text.match(JOIN_COMMAND);
  if (joinMatch) return handleJoinRequest(player, joinMatch[1]);

  const statusMatch = event.type === 'text' && event.text.match(STATUS_COMMAND);
  if (statusMatch) return handleTicketStatus(player, statusMatch[1]);

  if (event.type === 'text' && SUPPORT_COMMAND.test(event.text)) return handleSupportLink(player);

  if (event.type === 'text' && LEAVE_COMMAND.test(event.text)) return handleLeave(player);

  if (event.type === 'text' && GREETINGS.test(event.text)) return handleGreeting(player);

  if (event.type === 'button_reply' || event.type === 'list_reply') {
    return handleButton(player, state, event.replyId);
  }

  if (event.type === 'text') return handleText(player, state, event.text);

  return sendText(player.wa_id, copy.unknown());
}

// --- Greeting and consent --------------------------------------------------

async function handleGreeting(player) {
  if (!(await hasConsented(player.id))) {
    await sendText(player.wa_id, copy.greeting());
    await setState(player.id, STATES.AWAITING_CONSENT, {});
    return sendButtons(player.wa_id, copy.consent(), consentButtons());
  }
  return showMenu(player);
}

async function showMenu(player) {
  await setState(player.id, STATES.MENU, {});
  return sendButtons(player.wa_id, copy.menu(), menuButtons(), { header: config.brandName });
}

/**
 * After agreeing, resume whatever the player was trying to do. An invited
 * player who tapped a JOIN link is put straight into that game rather than
 * being dropped at a menu they did not ask for.
 */
async function handleConsent(player, state) {
  await recordConsent(player.id);
  await recordEvent({ type: 'consent.accepted', source: 'whatsapp', playerId: player.id });
  await sendText(player.wa_id, copy.consentDone());

  const pendingCode = state.context?.pendingJoinCode;
  if (pendingCode) return handleJoinRequest(player, pendingCode);

  return showMenu(player);
}

// --- Buttons ---------------------------------------------------------------

async function handleButton(player, state, replyId) {
  switch (replyId) {
    case BUTTONS.CONSENT_AGREE:
      return handleConsent(player, state);

    case BUTTONS.MENU_PLAY:
      return startHostFlow(player);

    case BUTTONS.MENU_JOIN:
      await setState(player.id, STATES.AWAITING_JOIN_CODE, {});
      return sendText(player.wa_id, copy.askJoinCode());

    case BUTTONS.MENU_OPTIONS:
      return sendList(player.wa_id, copy.optionsMenu(), optionsList());

    case OPTIONS.REPORT:   return handleRecentReport(player);
    case OPTIONS.DEMO:     return handleDemo(player);
    case OPTIONS.SPONSOR:  return sendText(player.wa_id, copy.sponsorPlaceholder());
    case OPTIONS.FEEDBACK: return handleFeedbackLink(player);
    case OPTIONS.SUPPORT:  return handleSupportLink(player);

    case BUTTONS.PLAN_FREE_TRIAL:
      return createRoom(player, state);

    case FEEDBACK_BUTTONS.RATE_5: return handleRating(player, state, 5);
    case FEEDBACK_BUTTONS.RATE_3: return handleRating(player, state, 3);
    case FEEDBACK_BUTTONS.RATE_1: return handleRating(player, state, 1);

    default:
      return sendText(player.wa_id, copy.unknown());
  }
}

// --- Hosting ---------------------------------------------------------------

async function startHostFlow(player) {
  const active = await findActiveGameForPlayer(player.id);
  if (active) {
    await sendCtaUrl(player.wa_id, copy.alreadyInGame(active.code), {
      displayText: 'Open game room',
      url: boardUrl(active.id, player.id),
    });
    return;
  }

  await setState(player.id, STATES.AWAITING_PLAYER_COUNT, {});
  return sendText(player.wa_id, copy.askPlayerCount(config.game.minPlayers, config.game.maxPlayers));
}

async function handlePlayerCount(player, raw) {
  const { minPlayers, maxPlayers } = config.game;
  const trimmed = raw.trim();

  // Strict: "8 players" or "8.5" are rejected rather than guessed at, because
  // silently misreading the count would size the room wrong.
  const valid = /^\d{1,3}$/.test(trimmed);
  const count = valid ? Number(trimmed) : NaN;

  if (!valid || count < minPlayers || count > maxPlayers) {
    return sendText(player.wa_id, copy.badPlayerCount(minPlayers, maxPlayers, trimmed));
  }

  await setState(player.id, STATES.AWAITING_PLAN, { playerCount: count });
  return sendButtons(player.wa_id, copy.planCard(count), planButtons());
}

async function createRoom(player, state) {
  const playerCount = state.context?.playerCount;
  if (!playerCount) {
    // The plan button was tapped from a stale message - restart cleanly rather
    // than creating a room of unknown size.
    return startHostFlow(player);
  }

  let game;
  try {
    game = await createGame({ hostPlayerId: player.id, expectedPlayers: playerCount });
  } catch (err) {
    if (err instanceof GameError) return sendText(player.wa_id, copy.joinFailed(err.message));
    throw err;
  }

  await setState(player.id, STATES.IN_LOBBY, { gameId: game.id, code: game.code });
  await recordEvent({
    type: 'game.created', source: 'whatsapp', playerId: player.id, gameId: game.id,
    properties: { code: game.code, expectedPlayers: playerCount },
  });

  await sendText(player.wa_id, copy.gameCreated(game.code, inviteUrl(game.code)));
  return sendCtaUrl(player.wa_id, copy.hostStartWarning(), {
    displayText: 'Open host screen',
    url: boardUrl(game.id, player.id),
  });
}

// --- Joining ---------------------------------------------------------------

async function handleJoinRequest(player, rawCode) {
  const code = normaliseRoomCode(rawCode);

  // Consent first, but remember where they were headed.
  if (!(await hasConsented(player.id))) {
    await setState(player.id, STATES.AWAITING_CONSENT, { pendingJoinCode: code });
    await sendText(player.wa_id, copy.greeting());
    return sendButtons(player.wa_id, copy.consent(), consentButtons());
  }

  if (!looksLikeRoomCode(code)) {
    await setState(player.id, STATES.AWAITING_JOIN_CODE, {});
    return sendText(player.wa_id, copy.badJoinCode(rawCode));
  }

  const game = await getGameByCode(code);
  if (!game) {
    await setState(player.id, STATES.AWAITING_JOIN_CODE, {});
    return sendText(player.wa_id, copy.joinFailed('that game code does not exist'));
  }

  try {
    const { game: joined, alreadyJoined } = await joinGame({ code, playerId: player.id });
    await setState(player.id, STATES.IN_LOBBY, { gameId: joined.id, code: joined.code });

    if (!alreadyJoined) {
      await recordEvent({
        type: 'game.joined', source: 'whatsapp', playerId: player.id, gameId: joined.id,
        properties: { code: joined.code },
      });
    }

    const host = await getPlayerById(joined.host_player_id);
    const body = alreadyJoined
      ? copy.alreadyJoined(joined.code)
      : copy.joined(joined.code, host ? displayNameFor(host) : null);

    return sendCtaUrl(player.wa_id, body, {
      displayText: 'Enter game room',
      url: boardUrl(joined.id, player.id),
    });
  } catch (err) {
    if (err instanceof GameError) return sendText(player.wa_id, copy.joinFailed(err.message));
    throw err;
  }
}

/**
 * A player leaves. If that drops a running game below the minimum the game is
 * abandoned, and everyone still in it is told - professionally, with no
 * celebration, because nobody won.
 */
async function handleLeave(player) {
  const active = await findActiveGameForPlayer(player.id);
  if (!active) return sendText(player.wa_id, copy.notInAGame());

  const { remaining, aborted } = await leaveGame({ gameId: active.id, playerId: player.id });
  await setState(player.id, STATES.MENU, {});
  await recordEvent({
    type: 'game.left', source: 'whatsapp', playerId: player.id, gameId: active.id,
    properties: { remaining, aborted },
  });

  await sendText(player.wa_id, copy.youLeft(active.code, aborted));

  if (aborted) {
    broadcast(active.id, 'game_over', { reason: 'abandoned', leaver: displayNameFor(player) });
    announceGameAbandoned(active.id, { leaverName: displayNameFor(player) })
      .catch((err) => log.error('abandon notice failed', { message: err.message }));
  }
}

// --- Options ---------------------------------------------------------------

/** Their most recent FINISHED game. A game still running has no report yet. */
async function handleRecentReport(player) {
  const { rows } = await query(
    `SELECT g.id, g.code, g.ended_at
       FROM game_players gp JOIN games g ON g.id = gp.game_id
      WHERE gp.player_id = $1 AND g.status IN ('finished','abandoned')
      ORDER BY g.ended_at DESC NULLS LAST LIMIT 1`,
    [player.id],
  );
  if (!rows[0]) return sendText(player.wa_id, copy.noRecentGame());

  const g = rows[0];
  const when = g.ended_at
    ? new Date(g.ended_at).toLocaleString('en-IN', {
        day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
        timeZone: config.timezone,
      })
    : 'recently';

  return sendCtaUrl(player.wa_id, copy.recentReport(g.code, when, reportUrl(g.id, player.id)), {
    displayText: 'Open report',
    url: reportUrl(g.id, player.id),
  });
}

async function handleDemo(player) {
  return sendCtaUrl(player.wa_id, copy.demoIntro(), {
    displayText: 'How to play',
    url: `${config.publicRoot}/public/demo`,
  });
}

async function handleFeedbackLink(player) {
  return sendCtaUrl(player.wa_id, copy.feedbackIntro(), {
    displayText: 'Give feedback',
    url: feedbackUrl(player.id),
  });
}

async function handleSupportLink(player) {
  return sendCtaUrl(player.wa_id, copy.supportIntro(), {
    displayText: 'Contact support',
    url: supportUrl(player.id),
  });
}

/** "status MP-XXXXXX" - checked without opening a browser. */
async function handleTicketStatus(player, reference) {
  const found = await getTicketByReference(reference);
  if (!found) return sendText(player.wa_id, copy.noSuchTicket(reference));
  return sendText(player.wa_id, copy.ticketStatus(found.ticket, found.messages));
}

// --- Feedback --------------------------------------------------------------

/**
 * A tapped star rating. Saved immediately - a rating with no comment is still
 * a rating, and asking for the comment first would lose most of them.
 */
async function handleRating(player, state, rating) {
  const gameId = state.context?.gameId ?? null;
  await saveRating({ playerId: player.id, gameId, rating });

  await setState(player.id, STATES.AWAITING_FEEDBACK_COMMENT, state.context ?? {});
  return sendText(player.wa_id, copy.ratingThanks(rating));
}

/** Whatever they type next becomes the comment. */
async function handleFeedbackComment(player, state, text) {
  const trimmed = text.trim();
  if (/^(no|nope|skip|nothing|na).?$/i.test(trimmed)) {
    await setState(player.id, STATES.MENU, {});
    return sendText(player.wa_id, copy.feedbackDone(false));
  }

  await saveComment({
    playerId: player.id,
    gameId: state.context?.gameId ?? null,
    comment: trimmed.slice(0, 1000),
  });
  await setState(player.id, STATES.MENU, {});
  return sendText(player.wa_id, copy.feedbackDone(true));
}

// --- Free text -------------------------------------------------------------

async function handleText(player, state, text) {
  switch (state.state) {
    case STATES.AWAITING_PLAYER_COUNT:
      return handlePlayerCount(player, text);

    case STATES.AWAITING_JOIN_CODE:
      return handleJoinRequest(player, text);

    case STATES.AWAITING_FEEDBACK_COMMENT:
      return handleFeedbackComment(player, state, text);

    case STATES.AWAITING_FEEDBACK:
      // They typed instead of tapping a rating - take it as the comment
      // rather than nagging them for a star they did not want to give.
      return handleFeedbackComment(player, state, text);

    case STATES.AWAITING_CONSENT:
      // They typed instead of tapping - re-send the button.
      return sendButtons(player.wa_id, copy.consent(), consentButtons());

    default:
      return handleLooseText(player, text);
  }
}

/**
 * Text that matched nothing else.
 *
 * Before giving up, check whether this player has a support ticket still in
 * play — if they do, this is almost certainly a reply to it. Telling someone
 * "I didn't understand that" when they are answering a question we asked is
 * the rudest thing the bot could do.
 */
async function handleLooseText(player, text) {
  const body = text.trim();

  if (body.length >= 3) {
    const ticket = await openTicketForPlayer(player.id);
    if (ticket) {
      await appendPlayerMessage(ticket, {
        body: body.slice(0, 2000),
        name: displayNameFor(player),
      });
      return sendText(player.wa_id, copy.replyAdded(ticket.reference));
    }
  }

  return sendText(player.wa_id, copy.unknown());
}
