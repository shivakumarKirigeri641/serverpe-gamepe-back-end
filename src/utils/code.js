/**
 * Room codes and signed board links.
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from '../config/env.js';

// No O/0, I/1, S/5 - these get read aloud and typed by hand, and a code that
// cannot be misheard is worth more than the extra entropy.
const ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ23456789';
const CODE_LENGTH = 6;

export function generateRoomCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[randomInt(0, ALPHABET.length)];
  return out;
}

/** Players type these by hand, so accept lowercase and stray spaces. */
export function normaliseRoomCode(input) {
  return String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function looksLikeRoomCode(input) {
  const code = normaliseRoomCode(input);
  return code.length === CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c));
}

/**
 * A board link identifies ONE PLAYER in ONE GAME, not just the game. Without
 * that, anyone holding the room code could open everyone else's ticket.
 *
 * The token is `<gameId>.<playerId>.<hmac>`; the signature covers both ids, so
 * a player cannot edit the link to become somebody else.
 */
export function signBoardToken(gameId, playerId) {
  const body = `${gameId}.${playerId}`;
  return `${body}.${sign(body)}`;
}

export function verifyBoardToken(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;

  const [gameId, playerId, signature] = parts;
  const expected = sign(`${gameId}.${playerId}`);

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const ids = { gameId: Number(gameId), playerId: Number(playerId) };
  // gameId 0 is legitimate: feedback and support links are about a player, not
  // a game. playerId always has to be a real row.
  if (!Number.isInteger(ids.gameId) || ids.gameId < 0) return null;
  if (!Number.isInteger(ids.playerId) || ids.playerId <= 0) return null;
  return ids;
}

function sign(body) {
  return createHmac('sha256', config.boardLinkSecret).update(body).digest('base64url').slice(0, 32);
}

/** The URL a player opens to play. */
export function boardUrl(gameId, playerId) {
  return `${config.publicRoot}/board/${signBoardToken(gameId, playerId)}`;
}

/**
 * The invite the host forwards. Tapping it opens WhatsApp with the join
 * message already typed, so a player never has to copy a code by hand.
 */
export function inviteUrl(code) {
  return `https://wa.me/${config.whatsapp.businessNumber}?text=${encodeURIComponent(`JOIN ${code}`)}`;
}

/**
 * Signed links to the player-facing forms.
 *
 * Same signing scheme as board links, with gameId 0 standing for "not about a
 * game" — so a feedback or support URL cannot be edited to impersonate someone
 * else, exactly like a board link.
 */
export function feedbackUrl(playerId, gameId = 0) {
  return `${config.publicRoot}/feedback/${signBoardToken(gameId, playerId)}`;
}

/**
 * The whole-history report. Signed per player like every other link, with
 * gameId 0 because it is not about one game.
 */
export function historyUrl(playerId) {
  return `${config.publicRoot}/history/${signBoardToken(0, playerId)}`;
}

export function supportUrl(playerId, gameId = 0) {
  return `${config.publicRoot}/support/${signBoardToken(gameId, playerId)}`;
}

/**
 * Fatafat round links.
 *
 * Namespaced with a prefix rather than reusing the board scheme directly. Both
 * sign a pair of ids, so without the prefix a tambola board token for game 7
 * would verify perfectly as a Fatafat token for round 7 - the ids are
 * different sequences, and one player's link would occasionally open another
 * player's round.
 */
export function signRoundToken(roundId, playerId) {
  const body = `fatafat:${roundId}.${playerId}`;
  return `f${roundId}.${playerId}.${sign(body)}`;
}

export function verifyRoundToken(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;

  const [rawRound, playerId, signature] = parts;
  if (!rawRound.startsWith('f')) return null;
  const roundId = rawRound.slice(1);

  const expected = sign(`fatafat:${roundId}.${playerId}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const ids = { roundId: Number(roundId), playerId: Number(playerId) };
  if (!Number.isInteger(ids.roundId) || ids.roundId <= 0) return null;
  if (!Number.isInteger(ids.playerId) || ids.playerId <= 0) return null;
  return ids;
}

/** The URL a player opens to play one Fatafat round. */
export function fatafatUrl(roundId, playerId) {
  return `${config.publicRoot}/fatafat/${signRoundToken(roundId, playerId)}`;
}
