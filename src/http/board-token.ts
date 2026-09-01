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

/**
 * The policies, on the website rather than the API.
 *
 * A player opening this from a chat sees mastipe.in — the address on our own
 * stationery — instead of api.mastipe.in, which is unfamiliar and is exactly
 * the shape of link people are taught not to tap.
 *
 * The API's own /public/policies page still exists and still works, because
 * links sent months ago must keep working forever.
 */
export function policiesUrl(docKey?: string): string | null {
  const site = env.SITE_BASE_URL || env.PUBLIC_BASE_URL;
  if (!site) return null;

  const origin = site.replace(/\/+$/, '');
  return docKey ? `${origin}/policies/${docKey}` : `${origin}/policies`;
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

/* ---------------------------------------------------------------- payments */

/**
 * Signed link to a checkout page.
 *
 * Carries the host and the room size rather than an order id, because the page
 * offers two things to buy and the choice is made there. Binding the link to an
 * order would mean minting a link per option and losing the comparison that is
 * the whole point of the page.
 *
 * Signed for the same reason as a board link: it can be forwarded, but not
 * forged for somebody else.
 */
export interface CheckoutTokenPayload {
  playerId: string;
  players: number;
}

export function createCheckoutToken(playerId: string, players: number): string {
  const data = Buffer.from(`pay:${playerId}:${players}`, 'utf8').toString('base64url');
  return `${data}.${sign(data)}`;
}

export function verifyCheckoutToken(token: string): CheckoutTokenPayload | null {
  const [data, signature] = token.split('.');
  if (!data || !signature) return null;

  const expected = Buffer.from(sign(data), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  const parts = Buffer.from(data, 'base64url').toString('utf8').split(':');
  if (parts[0] !== 'pay' || !parts[1]) return null;

  const players = Number(parts[2]);
  if (!Number.isFinite(players) || players < 1) return null;

  return { playerId: parts[1], players };
}

export function checkoutUrl(playerId: string, players: number): string | null {
  if (!env.PUBLIC_BASE_URL) return null;
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, '');
  return `${base}${apiPath('/public/pay')}/${createCheckoutToken(playerId, players)}`;
}

/**
 * The public how-to-play page.
 *
 * Unsigned, unlike the board and the checkout: it holds nothing personal and is
 * meant to be forwarded, linked from the marketing site, and opened by people
 * who have never messaged us.
 */
export function demoUrl(lang: 'en' | 'hi' = 'en'): string | null {
  if (!env.PUBLIC_BASE_URL) return null;
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, '');
  return `${base}${apiPath('/public/demo')}${lang === 'hi' ? '?lang=hi' : ''}`;
}
