import { createHmac, timingSafeEqual } from 'node:crypto';
import { apiPath, env } from '../config/env.js';

/**
 * Signed links to a player's board.
 *
 * A board shows one person's ticket, so the URL cannot be guessable: the token
 * carries the game and player ids and an HMAC over them. Anyone can hold the
 * link (it is opened in a browser outside WhatsApp), but nobody can forge one
 * for a different player, and it is worthless once the game ends.
 */

export interface BoardTokenPayload {
  gameId: string;
  playerId: string;
}

function secret(): string {
  return env.BOARD_LINK_SECRET || env.WHATSAPP_APP_SECRET || env.ADMIN_API_KEY || 'insecure-dev-secret';
}

function sign(data: string): string {
  return createHmac('sha256', secret()).update(data).digest('base64url');
}

export function createBoardToken(gameId: string, playerId: string): string {
  const data = Buffer.from(`${gameId}:${playerId}`, 'utf8').toString('base64url');
  return `${data}.${sign(data)}`;
}

export function verifyBoardToken(token: string): BoardTokenPayload | null {
  const [data, signature] = token.split('.');
  if (!data || !signature) return null;

  const expected = Buffer.from(sign(data), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  const [gameId, playerId] = Buffer.from(data, 'base64url').toString('utf8').split(':');
  if (!gameId || !playerId) return null;
  return { gameId, playerId };
}

/** Absolute URL to a player's board, or null if no public origin is configured. */
export function boardUrl(gameId: string, playerId: string): string | null {
  if (!env.PUBLIC_BASE_URL) return null;
  const origin = env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  return `${origin}${apiPath('/public/board')}/${createBoardToken(gameId, playerId)}`;
}

/** Public policies page. Same for every player, so no token is needed. */
export function policiesUrl(): string | null {
  if (!env.PUBLIC_BASE_URL) return null;
  return `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}${apiPath('/public/policies')}`;
}

/**
 * A link a host can forward to friends.
 *
 * Opening it starts a WhatsApp chat with the bot with "JOIN <code>" already
 * typed, so a friend joins by tapping and sending — no code to copy, no
 * spelling mistakes.
 */
export function inviteUrl(roomCode: string, gameName = 'Tambola'): string {
  // The prefilled text is what the friend sees sitting in their message box
  // before they press send. "JOIN ABC123" looks like a machine command and
  // makes people hesitate; a sentence tells them what pressing send will do.
  return whatsappReturnUrl(`JOIN ${roomCode} - I want to play ${gameName}!`);
}

/** Deep link back into the WhatsApp conversation with the bot. */
export function whatsappReturnUrl(text?: string): string {
  const number = env.WHATSAPP_BUSINESS_NUMBER.replace(/[^0-9]/g, '');
  if (!number) return 'https://wa.me/';
  return text ? `https://wa.me/${number}?text=${encodeURIComponent(text)}` : `https://wa.me/${number}`;
}
