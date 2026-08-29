import { env, trialEndLabel } from '../config/env.js';
import { getEngine, listEngines } from '../core/registry.js';
import type { Entry } from '../core/types.js';
import { redis } from '../redis/client.js';
import { logger } from '../utils/logger.js';
import {
  sendButtons,
  sendCtaUrl,
  sendDocument,
  sendList,
  sendText,
  uploadMedia,
} from '../whatsapp/client.js';
import type { InboundEvent } from '../whatsapp/types.js';
import { scheduleDraw } from '../workers/queue.js';
import {
  GameError,
  createGame,
  findActiveGameForPlayer,
  findGameById,
  joinGame,
  leaveGame,
  listAwardedClaims,
  listDrawnNumbers,
  listEntriesForPlayer,
  listMembers,
  recordDrawResponse,
  startGame,
  submitClaim,
  type GameRow,
} from './game.service.js';
import { displayNameOf, upsertPlayer, type PlayerRow } from './player.service.js';
import { ROOM_CODE_LENGTH, looksLikeRoomCode } from '../utils/ids.js';
import { EVENT, track } from './analytics.service.js';
import {
  acceptAllPending,
  getDocument,
  listActiveDocuments,
  pendingDocuments,
  type LegalDocument,
} from './consent.service.js';
import { amendContext, runWithContext } from '../utils/context.js';
import { appTimeString } from '../utils/time.js';
import {
  chargeableAmount,
  formatPrice,
  getPlan,
  listActivePlans,
  planRow,
} from './plan.service.js';
import { logInbound } from './message.service.js';
import { claimButtonId, maybeAdvanceEarly, parseFlowToken } from './round.service.js';
import { boardUrl, inviteUrl, policiesUrl } from '../http/board-token.js';
import { getStats, getWeeklyLeaderboard, leaderboardName, recordPrizeWon } from './stats.service.js';
import { buildPlayerReport } from './report.service.js';

/**
 * Which engine `play` starts. Nothing else in this file names a specific game —
 * all player-facing wording comes from the engine, so registering a second game
 * makes it playable with no changes here.
 */
const DEFAULT_GAME = env.DEFAULT_GAME_KEY;
const CONVERSATION_TTL_SECONDS = 300;

/** Short-lived "what is this player about to type" state. */
type Pending =
  | { awaiting: 'room_code' }
  | { awaiting: 'consent'; intent: 'play' | 'join'; gameKey?: string; roomCode?: string }
  | { awaiting: 'player_count'; gameKey: string }
  | { awaiting: 'plan'; gameKey: string; players: number };

/** Smallest room the platform allows — the host is one of these. */
const minimumPlayers = (): number => Math.max(2, env.MIN_PLAYERS_TO_START);

async function setPending(waId: string, pending: Pending): Promise<void> {
  await redis.set(`conv:${waId}`, JSON.stringify(pending), 'EX', CONVERSATION_TTL_SECONDS);
}

async function takePending(waId: string): Promise<Pending | null> {
  const raw = await redis.getdel(`conv:${waId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Pending;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ replies */

async function sendMainMenu(player: PlayerRow): Promise<void> {
  // A player who has not accepted the terms is shown those instead of a menu
  // offering to start a game they are not yet allowed to play.
  const pending = await pendingDocuments(player.id);
  if (pending.length > 0) return sendConsentPrompt(player, pending);

  const engines = listEngines();
  await track({
    type: EVENT.MENU_SHOWN,
    source: 'whatsapp',
    waId: player.wa_id,
    playerId: player.id,
    properties: { games: engines.length },
  });

  const featured = engines.find((e) => e.key === DEFAULT_GAME) ?? engines[0];
  const greeting = [
    `*Welcome to ${env.BRAND_NAME}* - ${env.BRAND_TAGLINE}`,
    '',
    featured ? `Ready to play ${featured.displayName}?` : 'Ready to play?',
    '',
    `_Free to play until ${trialEndLabel()}._`,
  ].join('\n');

  // The two things people came here to do stay one tap away as reply buttons;
  // everything else sits behind "More options". Putting the whole menu in a
  // list would make even "Play" two taps.
  await sendButtons(player.wa_id, greeting, [
    {
      id: `menu:play:${featured ? featured.key : DEFAULT_GAME}`,
      title: featured ? `Play ${featured.displayName}` : 'Play',
    },
    { id: 'menu:join', title: 'Join a game' },
    { id: 'menu:more', title: 'More options' },
  ]);
}

/** Everything that is not "play" or "join", as tappable rows. */
async function sendMoreOptions(player: PlayerRow): Promise<void> {
  const engines = listEngines();
  const rows = [
    ...engines.map((e) => ({
      id: `menu:play:${e.key}`,
      title: `Play ${e.displayName}`.slice(0, 24),
      description: e.description.slice(0, 72),
    })),
    { id: 'menu:join', title: 'Join a game', description: 'Enter a room code from a friend' },
    { id: 'cmd:stats', title: 'My stats', description: 'Full report as a PDF' },
    { id: 'cmd:board', title: 'Leaderboard', description: 'Top players this week' },
    { id: 'menu:help', title: 'How to play', description: 'The rules and the prizes' },
    { id: 'cmd:terms', title: 'Policies & terms', description: 'What you agreed to when you joined' },
    ...(env.PROMO_URL
      ? [{ id: 'cmd:quizpe', title: 'Try QuizPe', description: env.PROMO_TEXT.slice(0, 72) }]
      : []),
  ];

  await sendList(player.wa_id, 'What would you like to do?', 'Choose an option', rows.slice(0, 10), 'Menu');
}

/**
 * Cross-promotion for QuizPe.
 *
 * The description comes first and the button second: a bare link asks people to
 * tap before they know what they are tapping. The forwardable line below is the
 * point — most MastiPe players are the parents and relatives QuizPe is for.
 */
export async function sendPromo(
  waId: string,
  playerId: string | null,
  placement: 'menu' | 'game_over',
): Promise<void> {
  if (!env.PROMO_URL) return;

  await track({
    type: EVENT.PROMO_SHOWN,
    source: 'whatsapp',
    waId,
    playerId,
    properties: { url: env.PROMO_URL, placement },
  });

  await sendCtaUrl(
    waId,
    [`*QuizPe*`, '', env.PROMO_TEXT].join('\n'),
    'Open QuizPe',
    env.PROMO_URL,
    playerId ? { playerId } : undefined,
  );

  await sendText(
    waId,
    [
      '*Know a parent who would want this?* Forward the message below 👇',
      '',
      env.PROMO_SHARE_TEXT,
      env.PROMO_URL,
    ].join('\n'),
    playerId ? { playerId } : undefined,
  );
}

/**
 * A message the host can forward straight into any chat.
 *
 * Tapping the link opens WhatsApp with "JOIN <code>" already typed, so a friend
 * joins by sending one prefilled message — nothing to copy out and retype.
 */
function inviteLine(game: GameRow): string {
  const engine = getEngine(game.game_key);
  return [
    '*Invite your friends* — forward this message 👇',
    '',
    `Join my ${engine.displayName} game on ${env.BRAND_NAME}!`,
    inviteUrl(game.room_code),
  ].join('\n');
}

/**
 * "3 of 6 joined" when the host named a target, otherwise a plain count.
 * The target is a goal, not a cap — extra friends may still join.
 */
function lobbyCount(game: GameRow, members: number): string {
  if (game.expected_players) {
    const remaining = game.expected_players - members;
    return remaining > 0
      ? `*${members} of ${game.expected_players}* joined — waiting for ${remaining} more.`
      : `*${members} of ${game.expected_players}* joined — everyone is here!`;
  }
  return `${members} player${members === 1 ? '' : 's'} in the lobby.`;
}

/**
 * Pulls a room code out of free text.
 *
 * Only returns one when the word "join" is present or the message is short
 * enough to be a bare code, so ordinary chat containing a six-letter word is
 * not mistaken for a join.
 */
function findRoomCodeIn(text: string): string | null {
  const tokens = text.toUpperCase().match(/[A-Z0-9]{4,10}/g) ?? [];
  const looksLikeJoin = /join/i.test(text) || tokens.length === 1;
  if (!looksLikeJoin) return null;

  for (const token of tokens) {
    if (token !== 'JOIN' && looksLikeRoomCode(token)) return token;
  }
  return null;
}

/** Asks for a room code and arms the prompt that reads the answer. */
async function startJoinPrompt(player: PlayerRow): Promise<void> {
  await setPending(player.wa_id, { awaiting: 'room_code' });
  await sendText(
    player.wa_id,
    `Send me the ${ROOM_CODE_LENGTH}-character room code your host shared (for example *KFT7QM*).`,
  );
}

/** Asks the host how big the room should be, before the room exists. */
async function sendPlayerCountPrompt(
  player: PlayerRow,
  gameKey: string,
  consentAlreadyGiven = false,
): Promise<void> {
  if (!consentAlreadyGiven && !(await ensureConsent(player, 'play', gameKey))) return;

  // Check before asking. Asking "how many players?" and only then refusing
  // because they are mid-game wastes a round trip and reads as a bug.
  const active = await findActiveGameForPlayer(player.id);
  if (active) {
    await sendText(
      player.wa_id,
      `You are already in room *${active.room_code}*. Send *leave* to quit it before starting a new game.`,
    );
    return sendInGameMenu(player, active);
  }

  const engine = getEngine(gameKey);
  const min = minimumPlayers();

  // Typed rather than picked from a list: a host who wants 14 players should
  // not have to hunt through a menu, and the answer is a single short number.
  await setPending(player.wa_id, { awaiting: 'player_count', gameKey });
  await sendText(
    player.wa_id,
    [
      `*How many players* are you expecting for ${engine.displayName}?`,
      '',
      `Type a number between *${min}* and *${engine.maxPlayers}* — for example *6*.`,
      '',
      '_Counting you. More friends can still join, and you decide when to start._',
    ].join('\n'),
  );
}

/**
 * Second step of room creation: which plan is this game on.
 *
 * Plans that are not yet available are still listed, marked "(soon)", so a host
 * can see where this is going. Tapping one explains and re-offers the picker
 * rather than silently doing nothing.
 */
async function sendPlanPrompt(player: PlayerRow, gameKey: string, players: number): Promise<void> {
  const plans = await listActivePlans();

  if (plans.length === 0) {
    // No plans configured at all: do not block play over an admin oversight.
    return handlePlay(player, gameKey, players);
  }

  await setPending(player.wa_id, { awaiting: 'plan', gameKey, players });

  await sendList(
    player.wa_id,
    [
      `*Choose a plan* for your ${players}-player game.`,
      '',
      `_Free Trial is running until ${trialEndLabel()}._`,
    ].join('\n'),
    'Choose a plan',
    plans.slice(0, 10).map(planRow),
    'Plans',
  );
}

async function sendLobby(player: PlayerRow, game: GameRow): Promise<void> {
  const members = await listMembers(game.id);
  const engine = getEngine(game.game_key);
  const isHost = game.host_player_id === player.id;
  const url = boardUrl(game.id, player.id);

  // The ticket is not repeated here: it lives on the board page, where it
  // updates itself. A static copy in chat only goes stale and pushes the
  // things they actually need to tap off the screen.

  // Sent on its own so the host can forward it whole.
  await sendText(player.wa_id, inviteLine(game));

  if (url) {
    // The lobby page shows the count filling up live and carries Start, so the
    // host is not refreshing chat to find out who arrived.
    await sendCtaUrl(
      player.wa_id,
      [
        `Room *${game.room_code}* is open.`,
        '',
        lobbyCount(game, members.length),
        '',
        isHost
          ? 'Open the game page to watch friends join, then start when you are ready.'
          : '*The host has to start the game* — hang on a few seconds.',
      ].join('\n'),
      isHost ? 'Open & start game' : 'Open game page',
      url,
      { playerId: player.id, gameId: game.id },
      `Room ${game.room_code}`,
    );
    return;
  }

  await sendText(
    player.wa_id,
    [`Room *${game.room_code}* is open.`, '', lobbyCount(game, members.length)].join('\n'),
  );

  if (isHost) {
    await sendButtons(player.wa_id, 'Ready when you are.', [
      { id: `start:${game.id}`, title: 'Start game' },
      { id: 'cmd:entry', title: `My ${engine.entryNoun}` },
      { id: 'cmd:leave', title: 'Leave game' },
    ]);
  } else {
    await sendText(player.wa_id, '_The host has to start the game — hang on a few seconds._');
  }
}

/** Rules come from the engine; the command list is platform-level. */
async function sendHelp(player: PlayerRow, gameKey = DEFAULT_GAME): Promise<void> {
  const engine = getEngine(gameKey);
  await track({
    type: EVENT.HELP_SHOWN,
    source: 'whatsapp',
    waId: player.wa_id,
    playerId: player.id,
    properties: { gameKey },
  });

  await sendText(
    player.wa_id,
    [
      engine.helpText(),
      '',
      '*Commands*',
      '`play` — start a new game',
      '`join CODE` — join a friend’s game',
      `\`${engine.entryNoun}\` — see your ${engine.entryNoun}`,
      '`status` — how the game is going',
      '`stats` — your record',
      '`board` — weekly leaderboard',
      '`leave` — leave the current game',
    ].join('\n'),
  );
}

/**
 * What "hi" gets you when you are already in a game.
 *
 * The generic welcome menu would offer to start or join a game, which is
 * nonsense mid-round and strands the player with no way back to their board.
 */
async function sendInGameMenu(player: PlayerRow, game: GameRow): Promise<void> {
  const engine = getEngine(game.game_key);

  if (game.status === 'lobby') {
    await sendText(player.wa_id, `You are in room *${game.room_code}*, waiting to start.`);
    await sendLobby(player, game);
    return;
  }

  const drawn = await listDrawnNumbers(game.id);
  await sendEntry(player, game);
  await sendButtons(
    player.wa_id,
    `You are playing in room *${game.room_code}* — ${drawn.length} number${drawn.length === 1 ? '' : 's'} called.`,
    [
      { id: 'cmd:claim', title: 'Claim a prize' },
      { id: 'cmd:status', title: 'Game status' },
      { id: `exit:${game.id}`, title: 'Exit game' },
    ],
  );
}

/** Re-sends the player's board(s) with everything drawn so far marked. */
async function sendEntry(player: PlayerRow, game: GameRow): Promise<void> {
  const engine = getEngine(game.game_key);
  const [entries, drawn] = await Promise.all([
    listEntriesForPlayer(game.id, player.id),
    listDrawnNumbers(game.id),
  ]);

  if (entries.length === 0) {
    await sendText(player.wa_id, `You are not holding a ${engine.entryNoun} in this game.`);
    return;
  }

  const text = entries
    .map((row) => {
      const entry: Entry = { entryNo: row.entry_no, payload: row.payload };
      return engine.renderEntry(entry as never, drawn);
    })
    .join('\n\n');

  await sendText(player.wa_id, text);
}

async function sendStatus(player: PlayerRow, game: GameRow): Promise<void> {
  const [drawn, awarded] = await Promise.all([listDrawnNumbers(game.id), listAwardedClaims(game.id)]);
  const engine = getEngine(game.game_key);
  const labels = new Map(engine.claims().map((c) => [c.key, c.label]));
  const last = drawn.slice(-10);

  await sendText(
    player.wa_id,
    [
      `Room *${game.room_code}* — ${game.status}`,
      `${drawn.length} number${drawn.length === 1 ? '' : 's'} called.`,
      last.length ? `Last called: ${last.join(', ')}` : '',
      '',
      awarded.length
        ? `*Prizes gone:* ${awarded.map((k) => labels.get(k) ?? k).join(', ')}`
        : '_All prizes still open._',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

async function sendClaimMenu(player: PlayerRow, game: GameRow): Promise<void> {
  const engine = getEngine(game.game_key);
  const awarded = await listAwardedClaims(game.id);
  const rows = engine
    .claims()
    .filter((c) => !awarded.includes(c.key))
    .sort((a, b) => a.order - b.order)
    .map((c) => ({ id: claimButtonId(game.id, c.key), title: c.label }));

  const exitRow = {
    id: `exit:${game.id}`,
    title: 'Exit game',
    description: `Leave room ${game.room_code} and stop receiving numbers`,
  };

  if (rows.length === 0) {
    await sendList(
      player.wa_id,
      'Every prize has already been won.',
      'Options',
      [exitRow],
      'Options',
    );
    return;
  }

  await sendList(
    player.wa_id,
    'Which prize are you claiming?',
    'Claim a prize',
    [...rows, exitRow],
    'Prizes',
  );
}

/* ------------------------------------------------------------------- legal */

/**
 * Shows the documents a player must accept, as a list of title + description
 * rows they can open individually, followed by an explicit agree/decline.
 *
 * Every word comes from the database, so the admin panel can rewrite any of it
 * without a deploy.
 */
async function sendConsentPrompt(player: PlayerRow, docs: LegalDocument[]): Promise<void> {
  await track({
    type: EVENT.CONSENT_PROMPTED,
    source: 'whatsapp',
    waId: player.wa_id,
    playerId: player.id,
    properties: { documents: docs.map((d) => `${d.doc_key}@v${d.version}`) },
  });

  const url = policiesUrl();

  // One message, one button. The link sits inline in the body rather than
  // being its own cta_url message, because WhatsApp will not put a URL button
  // and a reply button on the same message — and splitting it in two made the
  // player tap twice before they could get on with the game.
  const body = [
    `*Welcome to ${env.BRAND_NAME}* - ${env.BRAND_TAGLINE}`,
    '',
    'By continuing, you agree to the following terms & policies.',
    ...(url ? ['', url] : ['', docs.map((d) => `• ${d.title}`).join('\n')]),
  ].join('\n');

  await sendButtons(player.wa_id, body, [{ id: 'legal:agree', title: 'Agree & continue' }], {
    playerId: player.id,
  });
}

/**
 * Gate in front of anything that starts or joins a game.
 * Returns true when the player may proceed.
 */
async function ensureConsent(
  player: PlayerRow,
  intent: 'play' | 'join' = 'play',
  gameKey?: string,
  roomCode?: string,
): Promise<boolean> {
  const outstanding = await pendingDocuments(player.id);
  const active = await listActiveDocuments();

  // With CONSENT_EVERY_GAME the ledger is not the gate: a player who accepted
  // last week is still asked before this round, so every game carries its own
  // acceptance. The stored consent rows remain the record of what they agreed
  // to and when.
  const mustAsk = env.CONSENT_EVERY_GAME ? active.length > 0 : outstanding.length > 0;
  if (!mustAsk) return true;

  // Remember what they were about to do, so agreeing resumes it rather than
  // dumping them back at the menu to start again.
  // Remember the room they were joining, so agreeing drops them straight into
  // it rather than asking for the code a second time.
  await setPending(player.wa_id, {
    awaiting: 'consent',
    intent,
    ...(gameKey ? { gameKey } : {}),
    ...(roomCode ? { roomCode } : {}),
  });
  await sendConsentPrompt(player, outstanding.length > 0 ? outstanding : active);
  return false;
}

async function handleLegalAction(player: PlayerRow, rest: string[]): Promise<void> {
  const [what, docKey] = rest;

  if (what === 'doc' && docKey) {
    const doc = await getDocument(docKey);
    if (!doc) return;

    await track({
      type: EVENT.CONSENT_DOCUMENT_OPENED,
      source: 'whatsapp',
      waId: player.wa_id,
      playerId: player.id,
      properties: { docKey, version: doc.version },
    });

    await sendText(player.wa_id, doc.body);
    await sendButtons(player.wa_id, 'Ready to continue?', [
      { id: 'legal:agree', title: '✅ I agree' },
      { id: 'legal:read', title: 'Read the rest' },
      { id: 'legal:decline', title: 'I do not agree' },
    ]);
    return;
  }

  if (what === 'read') {
    const url = policiesUrl();
    const pending = await pendingDocuments(player.id);

    if (url) {
      await sendCtaUrl(
        player.wa_id,
        'Everything you are agreeing to, in full.',
        'Read policies & terms',
        url,
        { playerId: player.id },
      );
    }
    if (pending.length === 0) {
      await sendText(player.wa_id, 'You have already accepted everything. Send *play* to start a game.');
      return;
    }
    return sendConsentPrompt(player, pending);
  }

  if (what === 'decline') {
    await track({
      type: EVENT.CONSENT_DECLINED,
      source: 'whatsapp',
      waId: player.wa_id,
      playerId: player.id,
      properties: {},
    });
    await sendText(
      player.wa_id,
      [
        'That is completely fine — you can change your mind at any time.',
        '',
        `Without accepting, you cannot play ${env.BRAND_NAME}. Send *terms* whenever you want to read them again.`,
      ].join('\n'),
    );
    return;
  }

  if (what === 'agree') {
    const resume = await takePending(player.wa_id);
    const accepted = await acceptAllPending(player.id, { source: 'whatsapp' });

    // Always record the acceptance as an event, even when the ledger already
    // held these versions — with per-game consent that event IS the proof this
    // particular round was agreed to.
    await track({
      type: EVENT.CONSENT_ACCEPTED,
      source: 'whatsapp',
      waId: player.wa_id,
      playerId: player.id,
      properties: {
        newlyRecorded: accepted.length,
        everyGame: env.CONSENT_EVERY_GAME,
        intent: resume?.awaiting === 'consent' ? resume.intent : null,
      },
    });

    await sendText(player.wa_id, `✅ Thank you. Accepted on ${appTimeString()}.`);

    if (resume?.awaiting === 'consent') {
      if (resume.intent === 'join') {
        return resume.roomCode ? handleJoin(player, resume.roomCode, true) : startJoinPrompt(player);
      }
      return sendPlayerCountPrompt(player, resume.gameKey ?? DEFAULT_GAME, true);
    }
    return sendMainMenu(player);
  }
}

/* ------------------------------------------------------------------ actions */

async function handlePlay(
  player: PlayerRow,
  gameKey: string,
  expectedPlayers?: number,
  planKey?: string,
): Promise<void> {
  const active = await findActiveGameForPlayer(player.id);
  if (active) {
    await sendText(
      player.wa_id,
      `You are already in room *${active.room_code}*. Send *leave* first if you want a new game.`,
    );
    await sendLobby(player, active);
    return;
  }

  const plan = planKey ? await getPlan(planKey) : null;

  const game = await createGame({
    gameKey,
    hostPlayerId: player.id,
    expectedPlayers,
    planKey: plan?.plan_key,
    // Recorded at the price in force today, so a later price change never
    // rewrites the history of games already played.
    planPricePaise: plan ? chargeableAmount(plan) : 0,
  });
  await joinGame(game.room_code, player.id);

  await track({
    type: EVENT.GAME_CREATED,
    source: 'whatsapp',
    waId: player.wa_id,
    playerId: player.id,
    gameId: game.id,
    properties: {
      gameKey,
      roomCode: game.room_code,
      entryFeePaise: game.entry_fee_paise,
      expectedPlayers: expectedPlayers ?? null,
      planKey: plan?.plan_key ?? null,
      planPricePaise: game.plan_price_paise,
    },
  });

  if (plan) {
    await sendText(
      player.wa_id,
      `Plan: *${plan.name}* — ${formatPrice(plan)}${chargeableAmount(plan) === 0 ? ' (free trial)' : ''}`,
    );
  }

  amendContext({ gameId: game.id });
  const refreshed = (await findGameById(game.id)) ?? game;
  await sendLobby(player, refreshed);
}

async function handleJoin(
  player: PlayerRow,
  roomCode: string,
  consentAlreadyGiven = false,
): Promise<void> {
  if (!consentAlreadyGiven && !(await ensureConsent(player, 'join', undefined, roomCode))) return;

  const result = await joinGame(roomCode, player.id);
  amendContext({ gameId: result.game.id });
  await sendLobby(player, result.game);

  if (result.alreadyJoined) return;

  await track({
    type: EVENT.GAME_JOINED,
    source: 'whatsapp',
    waId: player.wa_id,
    playerId: player.id,
    gameId: result.game.id,
    properties: {
      roomCode: result.game.room_code,
      entries: result.entries.length,
    },
  });

  // Tell the host, but do not fan the notification out to the whole room —
  // a 30-player lobby would otherwise generate 900 messages.
  const host = result.game.host_player_id;
  if (host && host !== player.id) {
    const members = await listMembers(result.game.id);
    const hostRow = members.find((m) => m.player_id === host);
    if (!hostRow) return;

    const target = result.game.expected_players;
    const full = target !== null && members.length >= target;

    const tally = target
      ? `*${members.length} of ${target}*`
      : `*${members.length}* player${members.length === 1 ? '' : 's'}`;

    await sendText(
      hostRow.wa_id,
      full
        ? `*${displayNameOf(player)}* joined — that's ${tally}. Everyone is here!`
        : `*${displayNameOf(player)}* joined *${result.game.room_code}* — ${tally} so far.`,
    );

    // Nudge the host to start once the room is full and legal to begin.
    if (full && members.length >= minimumPlayers()) {
      await sendButtons(hostRow.wa_id, 'Ready to begin?', [
        { id: `start:${result.game.id}`, title: 'Start game' },
        { id: 'cmd:status', title: 'Who has joined' },
      ]);
    }
  }
}

export async function handleStart(player: PlayerRow, gameId: string): Promise<void> {
  const game = await startGame(gameId, player.id);
  const members = await listMembers(game.id);

  await track({
    type: EVENT.GAME_STARTED,
    source: 'whatsapp',
    waId: player.wa_id,
    playerId: player.id,
    gameId: game.id,
    properties: {
      roomCode: game.room_code,
      players: members.length,
      lobbyWaitMs: Date.now() - new Date(game.created_at).getTime(),
    },
  });

  for (const member of members) {
    const url = boardUrl(game.id, member.player_id);
    const ctx = { playerId: member.player_id, gameId: game.id };

    if (url) {
      // Once a game is running the board is the main surface: the ticket, the
      // prizes and the exit all live there and update on their own.
      await sendCtaUrl(
        member.wa_id,
        [
          '🎯 *The game is starting!*',
          '',
          'Open your board to watch your ticket fill up, answer each number and claim your prizes.',
        ].join('\n'),
        'Open my board',
        url,
        ctx,
        'Keep it open while you play',
      );
    } else {
      await sendText(
        member.wa_id,
        ['🎯 *The game is starting!*', '', 'Numbers will be called one at a time. Good luck!'].join('\n'),
        ctx,
      );
    }
  }

  // Cursor is 0 at kick-off; the first number goes out immediately.
  await scheduleDraw(game.id, 0, 0);
}

export async function handleAck(player: PlayerRow, gameId: string, seq: number, hasNumber: boolean): Promise<void> {
  // Buttons stay tappable forever in chat history. A tap on last week's number
  // must not write a response row for a finished game, nor wake its draw loop.
  const game = await findGameById(gameId);
  if (!game || game.status !== 'running') {
    if (game) {
      await sendText(player.wa_id, `That round in room *${game.room_code}* has already finished.`);
    }
    return;
  }

  await recordDrawResponse(gameId, seq, player.id, hasNumber);

  await track({
    type: EVENT.GAME_ACK,
    source: 'whatsapp',
    waId: player.wa_id,
    playerId: player.id,
    gameId,
    properties: { seq, hasNumber },
  });

  await maybeAdvanceEarly(gameId, seq);
}

export async function handleClaim(player: PlayerRow, gameId: string, claimType: string): Promise<void> {
  const result = await submitClaim(gameId, player.id, claimType);

  if (!result.outcome.ok) {
    await track({
      type: EVENT.CLAIM_REJECTED,
      source: 'whatsapp',
      waId: player.wa_id,
      playerId: player.id,
      gameId,
      properties: { claimType, reason: result.outcome.reason },
    });
    await sendText(player.wa_id, `❌ ${result.outcome.reason}`, {
      playerId: player.id,
      gameId,
    });
    return;
  }

  const game = await findGameById(gameId);
  if (!game) return;
  const engine = getEngine(game.game_key);
  const label = engine.claims().find((c) => c.key === claimType)?.label ?? claimType;

  await recordPrizeWon(player.id, claimType);

  await track({
    type: EVENT.CLAIM_AWARDED,
    source: 'whatsapp',
    waId: player.wa_id,
    playerId: player.id,
    gameId,
    properties: {
      claimType,
      label,
      prizePaise: result.prizePaise,
      entryNo: result.entryNo ?? null,
      endedGame: result.gameFinished,
    },
  });

  const members = await listMembers(gameId);
  // A Full House ends the round, so it is announced as the result of the game
  // rather than as one more prize among several.
  const announcement = result.gameFinished
    ? [
        `🏆 *${displayNameOf(player)} has won the game!*`,
        '',
        `${label} — room *${game.room_code}*.`,
        '',
        '*Game over.* Thanks for playing!',
      ].join('\n')
    : `🏆 *${displayNameOf(player)}* wins *${label}*!`;

  for (const member of members) {
    await sendText(member.wa_id, announcement, { playerId: member.player_id, gameId });
  }

  if (result.gameFinished) {
    const { concludeGame } = await import('./round.service.js');
    await concludeGame(gameId);
  }
}

/**
 * Removes a player from a game and tells everyone who needs to know: the
 * leaver, a promoted host, and — when the room can no longer continue — the
 * players still in it.
 */
export async function handleLeave(player: PlayerRow, gameId: string): Promise<void> {
  const game = await findGameById(gameId);
  if (!game || !['lobby', 'running'].includes(game.status)) {
    await sendText(player.wa_id, 'That game is already over.');
    return;
  }

  const wasHost = game.host_player_id === player.id;
  const result = await leaveGame(game.id, player.id);

  await track({
    type: EVENT.GAME_LEFT,
    source: 'whatsapp',
    waId: player.wa_id,
    playerId: player.id,
    gameId: game.id,
    properties: {
      roomCode: game.room_code,
      wasHost,
      gameCancelled: result.gameCancelled,
      remaining: result.remaining,
    },
  });

  await sendText(player.wa_id, `You have left room *${game.room_code}*. Send *play* to start a new game.`);

  // The room could not continue without them — tell whoever is left, rather
  // than leaving them waiting for numbers that will never arrive.
  if (result.gameCancelled) {
    const stranded = await listMembers(game.id);
    const notice =
      result.remaining === 0
        ? `Room *${game.room_code}* closed — everyone has left.`
        : `Room *${game.room_code}* closed — too few players left to continue. Send *play* to start a new game.`;

    for (const m of stranded) {
      await sendText(m.wa_id, notice);
    }
    return;
  }

  if (result.newHost) {
    await sendText(
      result.newHost.wa_id,
      `*${displayNameOf(player)}* left, so you are now the host of room *${game.room_code}*.`,
    );
    if (game.status === 'lobby') {
      await sendButtons(result.newHost.wa_id, 'You can start the game when everyone is ready.', [
        { id: `start:${game.id}`, title: 'Start game' },
        { id: 'cmd:status', title: 'Who has joined' },
      ]);
    }
  }
}

async function handleStats(player: PlayerRow): Promise<void> {
  const stats = await getStats(player.id);

  // The headline numbers stay in chat — most people only want these, and a PDF
  // they have to open is a poor answer to "how am I doing".
  await sendText(
    player.wa_id,
    [
      `*${displayNameOf(player)}*`,
      `Games played: *${stats.games_played}*`,
      `Prizes won: *${stats.prizes_won}*`,
      `Full houses: *${stats.full_houses}*`,
      `Points: *${stats.points}*`,
      '',
      '_Preparing your full report…_',
    ].join('\n'),
    { playerId: player.id },
  );

  // The full report follows as a PDF: charts, timings and game history that
  // would be unreadable as chat text.
  try {
    const { buffer, filename } = await buildPlayerReport(player);
    const mediaId = await uploadMedia(buffer, 'application/pdf', filename);

    if (!mediaId) {
      await sendText(player.wa_id, 'Could not build your report just now. Please try again shortly.');
      return;
    }

    await sendDocument(
      player.wa_id,
      mediaId,
      filename,
      `Your ${env.BRAND_NAME} report — activity, timings and every game you have played.`,
      { playerId: player.id },
    );
  } catch (err) {
    logger.error({ err, playerId: player.id }, 'failed to build player report');
    await sendText(player.wa_id, 'Could not build your report just now. Please try again shortly.');
  }
}

async function handleLeaderboard(player: PlayerRow): Promise<void> {
  const rows = await getWeeklyLeaderboard(10);
  if (rows.length === 0) {
    await sendText(player.wa_id, 'No games played yet this week. Send *play* to be the first!');
    return;
  }
  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.map((r, i) => `${medals[i] ?? `${i + 1}.`} ${leaderboardName(r)} — *${r.points}* pts`);
  await sendText(player.wa_id, ['🏅 *This week’s leaderboard*', '', ...lines].join('\n'));
}

/* ------------------------------------------------------------------- router */

/**
 * Single entry point for every inbound WhatsApp event. Resolves the player,
 * works out what they meant, and performs it. All game errors are surfaced to
 * the user as plain chat messages rather than thrown.
 */
export async function handleInbound(event: InboundEvent): Promise<void> {
  const player = await upsertPlayer(event.waId, event.profileName);

  const activeGame = await findActiveGameForPlayer(player.id);
  await logInbound(event, player.id, activeGame?.id ?? null);

  await track({
    type: player.is_new ? EVENT.PLAYER_CREATED : EVENT.PLAYER_RETURNED,
    source: 'whatsapp',
    waId: player.wa_id,
    playerId: player.id,
    gameId: activeGame?.id ?? null,
    properties: { profileName: event.profileName ?? null },
  });

  if (player.is_blocked) return;

  // Everything from here on is attributed to this player (and their game, once
  // one is identified) without each call site having to say so.
  await runWithContext({ playerId: player.id, gameId: activeGame?.id }, async () => {
    try {
      // 1. Flow submission — carries both the acknowledgement and any claim.
      if (event.flowResponse) {
        await handleFlowSubmission(player, event);
        return;
      }

      // 2. Button / list taps.
      if (event.actionId) {
        await handleAction(player, event.actionId);
        return;
      }

      // 3. Photos, voice notes, stickers, locations — say so, then re-offer
      //    whatever the player can actually do right now.
      if (event.unsupportedType) {
        await handleUnsupported(player, event.unsupportedType);
        return;
      }

      // 4. Free text.
      await handleText(player, event.text);
    } catch (err) {
      if (err instanceof GameError) {
        await track({
          type: EVENT.GAME_JOIN_FAILED,
          source: 'whatsapp',
          waId: player.wa_id,
          playerId: player.id,
          properties: {
            message: err.message,
            input: event.actionId ?? event.text,
          },
        });
        await sendText(player.wa_id, `⚠️ ${err.message}`);
        return;
      }

      await track({
        type: EVENT.ERROR,
        source: 'whatsapp',
        waId: player.wa_id,
        playerId: player.id,
        properties: {
          message: err instanceof Error ? err.message : String(err),
        },
      });
      logger.error({ err, waId: event.waId }, 'failed to handle inbound message');
      await sendText(player.wa_id, 'Something went wrong on our side. Please try again.');
    }
  });
}

const UNSUPPORTED_LABEL: Readonly<Record<string, string>> = {
  image: 'a photo',
  video: 'a video',
  audio: 'a voice note',
  document: 'a file',
  sticker: 'a sticker',
  location: 'a location',
  contacts: 'a contact',
  reaction: 'a reaction',
};

/**
 * Answers a message we cannot act on by re-offering the current options.
 *
 * Silence would read as the bot being broken, and a bare error is a dead end —
 * so every reply ends with something tappable.
 */
async function handleUnsupported(player: PlayerRow, messageType: string): Promise<void> {
  await track({
    type: EVENT.COMMAND_UNRECOGNISED,
    source: 'whatsapp',
    waId: player.wa_id,
    playerId: player.id,
    properties: { messageType },
  });

  const what = UNSUPPORTED_LABEL[messageType] ?? 'that';
  await sendText(player.wa_id, `I cannot read ${what} — please tap a button or send a word.`);

  const game = await findActiveGameForPlayer(player.id);
  return game ? sendInGameMenu(player, game) : sendMainMenu(player);
}

async function handleFlowSubmission(player: PlayerRow, event: InboundEvent): Promise<void> {
  const token = event.flowToken ?? (event.flowResponse?.['flow_token'] as string | undefined);
  const parsed = token ? parseFlowToken(token) : null;
  if (!parsed) {
    logger.warn({ waId: player.wa_id }, 'flow reply without a usable token');
    return;
  }

  const hasNumber = event.flowResponse?.['has_number'] === 'yes';
  await handleAck(player, parsed.gameId, parsed.seq, hasNumber);

  const claim = event.flowResponse?.['claim'];
  if (typeof claim !== 'string' || !claim || claim === 'none') return;

  // "Exit this game" shares the dropdown with the prizes, but it is not a
  // claim. Route it to the same confirmation the chat Exit button uses — a
  // player should never leave a round on a single mis-selection.
  if (claim === 'exit') {
    const game = await findGameById(parsed.gameId);
    if (!game || !['lobby', 'running'].includes(game.status)) return;

    await sendButtons(
      player.wa_id,
      `Leave room *${game.room_code}*? You will stop receiving numbers and cannot rejoin this round.`,
      [
        { id: `exitconfirm:${game.id}`, title: 'Yes, exit' },
        { id: 'cmd:entry', title: 'Stay in game' },
      ],
    );
    return;
  }

  await handleClaim(player, parsed.gameId, claim);
}

async function handleAction(player: PlayerRow, actionId: string): Promise<void> {
  const [kind, ...rest] = actionId.split(':');

  switch (kind) {
    case 'menu': {
      const [what, arg] = rest;
      if (what === 'play') return sendPlayerCountPrompt(player, arg ?? DEFAULT_GAME);
      if (what === 'more') return sendMoreOptions(player);
      if (what === 'join') {
        // Same guard as the typed `join` command — a stale menu button from
        // before the game started must not pull them into a second room.
        const current = await findActiveGameForPlayer(player.id);
        if (current) {
          await sendText(
            player.wa_id,
            `You are already in room *${current.room_code}*. Send *leave* before joining another game.`,
          );
          return sendInGameMenu(player, current);
        }
        return startJoinPrompt(player);
      }
      return sendHelp(player);
    }

    // Host answered "how many players?" from the picker.
    case 'count': {
      const [gameKey, value] = rest;
      const key = gameKey ?? DEFAULT_GAME;

      if (value === 'more') {
        await setPending(player.wa_id, { awaiting: 'player_count', gameKey: key });
        await sendText(
          player.wa_id,
          `How many players in total? Send a number between ${minimumPlayers()} and ${getEngine(key).maxPlayers}.`,
        );
        return;
      }

      await takePending(player.wa_id);
      return sendPlanPrompt(player, key, Number(value));
    }

    // Leaving mid-game is confirmed: these buttons sit next to "I have it",
    // and a mis-tap would drop the player out of a round they are winning.
    case 'exit': {
      const game = await findGameById(rest[0] as string);
      if (!game || !['lobby', 'running'].includes(game.status)) {
        await sendText(player.wa_id, 'That game is already over.');
        return;
      }
      await sendButtons(
        player.wa_id,
        `Leave room *${game.room_code}*? You will stop receiving numbers and cannot rejoin this round.`,
        [
          { id: `exitconfirm:${game.id}`, title: 'Yes, exit' },
          { id: 'cmd:entry', title: 'Stay in game' },
        ],
      );
      return;
    }

    case 'exitconfirm':
      return handleLeave(player, rest[0] as string);

    case 'plan': {
      const pending = await takePending(player.wa_id);
      const gameKey = pending?.awaiting === 'plan' ? pending.gameKey : DEFAULT_GAME;
      const players = pending?.awaiting === 'plan' ? pending.players : minimumPlayers();

      // "(soon)" rows are listed so hosts can see what is coming, but tapping
      // one must explain rather than quietly do nothing.
      if (rest[0] === 'soon') {
        const plan = await getPlan(rest[1] as string);
        await sendText(
          player.wa_id,
          plan
            ? `*${plan.name}* is not available yet.\n\n${plan.description}`
            : 'That plan is not available yet.',
        );
        return sendPlanPrompt(player, gameKey, players);
      }

      const plan = await getPlan(rest[0] as string);
      if (!plan || !plan.is_selectable || !plan.is_active) {
        await sendText(player.wa_id, 'That plan is not available. Please pick another.');
        return sendPlanPrompt(player, gameKey, players);
      }

      return handlePlay(player, gameKey, players, plan.plan_key);
    }

    case 'legal':
      return handleLegalAction(player, rest);

    case 'start':
      return handleStart(player, rest[0] as string);

    case 'ack': {
      const [gameId, seqRaw, yn] = rest;
      return handleAck(player, gameId as string, Number(seqRaw), yn === 'y');
    }

    case 'claim':
      return handleClaim(player, rest[0] as string, rest.slice(1).join(':'));

    case 'claimmenu': {
      const game = await findGameById(rest[0] as string);
      if (game) return sendClaimMenu(player, game);
      return;
    }

    case 'cmd':
      return handleText(player, rest.join(':'));

    default:
      return sendMainMenu(player);
  }
}

async function handleText(player: PlayerRow, rawText: string): Promise<void> {
  const text = rawText.trim();
  const lower = text.toLowerCase();

  // A few words always escape a pending question. Without this, a player who
  // is asked "how many players?" has no way to back out — every reply is read
  // as an answer, including "hi".
  const ESCAPE_WORDS = ['hi', 'hello', 'hey', 'menu', 'cancel', 'back', 'stop', 'help', 'terms'];

  // A pending prompt takes priority: the next thing they send is the answer.
  const pending = ESCAPE_WORDS.includes(lower) ? null : await takePending(player.wa_id);
  if (ESCAPE_WORDS.includes(lower)) await takePending(player.wa_id);

  if (pending?.awaiting === 'room_code') {
    const code = text.replace(/\s+/g, '').toUpperCase();

    // Re-ask rather than dropping them back to the menu — a typo should not
    // cost them their place in the conversation.
    if (!looksLikeRoomCode(text)) {
      await setPending(player.wa_id, pending);
      await sendText(
        player.wa_id,
        `That does not look like a room code. Send the ${ROOM_CODE_LENGTH} characters your host shared, for example *KFT7QM*.`,
      );
      return;
    }

    try {
      return await handleJoin(player, code);
    } catch (err) {
      // Wrong-but-well-formed code: keep the prompt alive for another try.
      if (err instanceof GameError) {
        await setPending(player.wa_id, pending);
        await sendText(player.wa_id, `⚠️ ${err.message}\n\nSend another code, or *menu* to go back.`);
        return;
      }
      throw err;
    }
  }

  if (pending?.awaiting === 'player_count') {
    const engine = getEngine(pending.gameKey);
    const wanted = Number.parseInt(text, 10);

    if (Number.isNaN(wanted) || wanted < minimumPlayers() || wanted > engine.maxPlayers) {
      // Re-arm the prompt rather than dropping them back to the main menu.
      await setPending(player.wa_id, pending);
      await sendText(
        player.wa_id,
        `Please send a number between ${minimumPlayers()} and ${engine.maxPlayers}.`,
      );
      return;
    }
    return sendPlanPrompt(player, pending.gameKey, wanted);
  }

  // The invite link prefills a sentence, and people edit it, add emoji, or
  // forward it with extra words. Rather than demanding an exact "JOIN ABC123",
  // look for anything in the message that is shaped like a room code.
  const codeInText = findRoomCodeIn(text);
  if (codeInText) return handleJoin(player, codeInText);

  switch (lower) {
    case 'hi':
    case 'hello':
    case 'hey':
    case 'menu':
    case 'start': {
      // Mid-game, greet them back into their game rather than out of it.
      const current = await findActiveGameForPlayer(player.id);
      return current ? sendInGameMenu(player, current) : sendMainMenu(player);
    }

    case 'play':
    case 'new':
      return sendPlayerCountPrompt(player, DEFAULT_GAME);

    // Shortcut past the plan picker while the trial is the only live plan.
    case 'start free trial':
    case 'start free trail':
    case 'free trial':
    case 'free trail':
      return sendPlayerCountPrompt(player, DEFAULT_GAME);

    case 'join': {
      const current = await findActiveGameForPlayer(player.id);
      if (current) {
        await sendText(
          player.wa_id,
          `You are already in room *${current.room_code}*. Send *leave* before joining another game.`,
        );
        return sendInGameMenu(player, current);
      }
      return startJoinPrompt(player);
    }

    case 'help':
    case 'how to play':
      return sendHelp(player);

    case 'quizpe':
    case 'promo':
      return sendPromo(player.wa_id, player.id, 'menu');

    case 'terms':
    case 'privacy':
    case 'legal': {
      const docs = await listActiveDocuments();
      if (docs.length === 0) {
        await sendText(player.wa_id, 'No documents are published yet.');
        return;
      }
      await sendList(
        player.wa_id,
        '*Our policies*\n\nTap any item to read it in full.',
        'Open a document',
        docs.slice(0, 10).map((d) => ({
          id: `legal:doc:${d.doc_key}`,
          title: d.title,
          description: d.summary,
        })),
        'Policies',
      );
      return;
    }

    case 'stats':
      return handleStats(player);

    case 'board':
    case 'leaderboard':
      return handleLeaderboard(player);

    default:
      break;
  }

  // Everything below needs a game in progress.
  const game = await findActiveGameForPlayer(player.id);

  if (!game && text && !['entry', 'ticket', 'status', 'leave', 'claim'].includes(lower)) {
    await track({
      type: EVENT.COMMAND_UNRECOGNISED,
      source: 'whatsapp',
      waId: player.wa_id,
      playerId: player.id,
      properties: { text: text.slice(0, 64) },
    });
  }

  if (!game) {
    if (['entry', 'ticket', 'status', 'leave', 'claim'].includes(lower)) {
      await sendText(player.wa_id, 'You are not in a game right now. Send *play* to start one.');
      return;
    }
    // Say we did not understand before repeating the menu, so a returning
    // player is not greeted with "Welcome!" every time they mistype.
    if (text) {
      await sendText(player.wa_id, 'I did not understand that. Here is what you can do:');
    }
    return sendMainMenu(player);
  }

  const activeEngine = getEngine(game.game_key);
  if (lower === activeEngine.entryNoun) return sendEntry(player, game);

  switch (lower) {
    case 'entry':
      return sendEntry(player, game);
    case 'status':
      return sendStatus(player, game);
    case 'claim':
      return sendClaimMenu(player, game);
    case 'leave':
      return handleLeave(player, game.id);

    // Anything unrecognised while in a game: point them back at their board,
    // not at a menu offering to start a game they are already in.
    default:
      return sendInGameMenu(player, game);
  }
}
