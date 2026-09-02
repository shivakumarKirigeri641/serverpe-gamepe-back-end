/**
 * Webhook authenticity.
 *
 * Meta signs the RAW request body. Express's json parser is configured to
 * stash that buffer on req.rawBody, because re-serialising the parsed object
 * produces different bytes (key order, whitespace) and the signature then
 * never matches - the classic reason a webhook silently rejects everything.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config/env.js';
import { log } from '../utils/logger.js';

/** Meta's GET handshake when you save the callback URL in the app dashboard. */
export function verifySubscription(queryParams) {
  const mode = queryParams['hub.mode'];
  const token = queryParams['hub.verify_token'];
  const challenge = queryParams['hub.challenge'];

  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
    return { ok: true, challenge };
  }
  log.warn('webhook verification rejected', {
    mode,
    tokenMatched: token === config.whatsapp.verifyToken,
    hint: 'the token here must equal WHATSAPP_VERIFY_TOKEN in .env',
  });
  return { ok: false };
}

/**
 * Checks X-Hub-Signature-256 against the raw body.
 *
 * With no app secret configured we accept and warn: that is the local
 * dry-run path, where webhooks are simulated rather than sent by Meta.
 */
export function verifySignature(req) {
  const secret = config.whatsapp.appSecret;
  if (!secret) return { ok: true, skipped: true };

  const header = req.get('x-hub-signature-256');
  if (!header) return { ok: false, reason: 'missing X-Hub-Signature-256 header' };
  if (!req.rawBody) return { ok: false, reason: 'raw body was not captured' };

  const expected = 'sha256=' + createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature mismatch - check WHATSAPP_APP_SECRET' };
  }
  return { ok: true };
}
