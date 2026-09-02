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
import { log } from '../utils/logger.js';
import { boardUrl, inviteUrl, looksLikeRoomCode, normaliseRoomCode } from '../utils/code.js';
import { sendText, sendButtons, sendCtaUrl } from '../whatsapp/client.js';
import { copy, BUTTONS, menuButtons, consentButtons, planButtons } from './copy.js';
import {
  findOrCreatePlayer, getState, setState, hasConsented, recordConsent,
  logMessage, displayNameFor, getPlayerById,
} from './player.service.js';
import {
  createGame, joinGame, getGameByCode, findActiveGameForPlayer, GameError,
} from './game.service.js';
import { recordEvent } from './tracking.service.js';

export const STATES = {
  NEW: 'new',
  AWAITING_CONSENT: 'awaiting_consent',
  MENU: 'menu',
  AWAITING_PLAYER_COUNT: 'awaiting_player_count',
  AWAITING_PLAN: 'awaiting_plan',
  AWAITING_JOIN_CODE: 'awaiting_join_code',
  IN_LOBBY: 'in_lobby',
  IN_GAME: 'in_game',
};

const GREETINGS = /^(hi|hii+|hey|hello|start|menu|namaste|namaskar)\b/i;
const JOIN_COMMAND = /^join\s+([a-z0-9]{4,10})$/i;

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

  // A JOIN link works from anywhere in the conversation - it is how invited
  // players arrive, and they should never have to navigate a menu first.
  const joinMatch = event.type === 'text' && event.text.match(JOIN_COMMAND);
  if (joinMatch) return handleJoinRequest(player, joinMatch[1]);

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
  await recordEvent({ type: 'consent_given', source: 'whatsapp', playerId: player.id });
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
      return sendText(player.wa_id, copy.optionsComingSoon());

    case BUTTONS.PLAN_FREE_TRIAL:
      return createRoom(player, state);

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
    type: 'game_created', source: 'whatsapp', playerId: player.id, gameId: game.id,
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
        type: 'player_joined', source: 'whatsapp', playerId: player.id, gameId: joined.id,
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

// --- Free text -------------------------------------------------------------

async function handleText(player, state, text) {
  switch (state.state) {
    case STATES.AWAITING_PLAYER_COUNT:
      return handlePlayerCount(player, text);

    case STATES.AWAITING_JOIN_CODE:
      return handleJoinRequest(player, text);

    case STATES.AWAITING_CONSENT:
      // They typed instead of tapping - re-send the button.
      return sendButtons(player.wa_id, copy.consent(), consentButtons());

    default:
      return sendText(player.wa_id, copy.unknown());
  }
}
