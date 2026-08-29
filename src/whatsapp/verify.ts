import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Meta signs every webhook POST with the app secret. Skipped when no secret is
 * configured so local development against a tunnel stub still works.
 */
export function verifySignature(rawBody: Buffer, headerValue: string | undefined): boolean {
  if (!env.WHATSAPP_APP_SECRET) return true;
  if (!headerValue?.startsWith('sha256=')) return false;

  const expected = createHmac('sha256', env.WHATSAPP_APP_SECRET).update(rawBody).digest();
  let received: Buffer;
  try {
    received = Buffer.from(headerValue.slice('sha256='.length), 'hex');
  } catch {
    return false;
  }
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

/** GET /webhook handshake Meta performs when you save the callback URL. */
export function verifyChallenge(queryParams: Record<string, unknown>): string | null {
  const mode = queryParams['hub.mode'];
  const token = queryParams['hub.verify_token'];
  const challenge = queryParams['hub.challenge'];
  if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN && typeof challenge === 'string') {
    return challenge;
  }
  return null;
}
