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

/**
 * Is this webhook addressed to our number?
 *
 * Webhook delivery on Meta follows the app-to-WABA subscription, not the phone
 * number: one callback URL receives events for every number under it. Two
 * products on one account therefore see each other's traffic, correctly signed
 * and otherwise indistinguishable. The only thing that says who a message was
 * for is metadata.phone_number_id, so that is what gets checked.
 *
 * Fails CLOSED for anything carrying messages. An earlier version processed a
 * payload whose metadata could not be read, on the reasoning that dropping a
 * real message is worse than answering a stray one. That is the wrong way round
 * here: answering somebody else's user is visible to them and cannot be undone,
 * while a dropped webhook is retried by Meta for hours.
 *
 * Status-only callbacks (delivery receipts) with no metadata are still allowed
 * through — they carry no message to answer, so they can do no harm, and they
 * are how we learn whether our own sends arrived.
 */
export function isForThisNumber(body: unknown): boolean {
  // No early "allow everything" escape: the schema makes the id required, so
  // reaching here without one is impossible. An escape hatch here would be a
  // way to disable the guard by deleting one line of config.

  const entries = (
    body as {
      entry?: Array<{
        changes?: Array<{
          value?: {
            metadata?: { phone_number_id?: string };
            messages?: unknown[];
            statuses?: unknown[];
          };
        }>;
      }>;
    }
  )?.entry;

  if (!Array.isArray(entries)) return false;

  const values = entries.flatMap((e) => e.changes ?? []).map((c) => c.value).filter(Boolean);
  if (values.length === 0) return false;

  return values.some((v) => {
    const id = v?.metadata?.phone_number_id;
    if (id) return id === env.WHATSAPP_PHONE_NUMBER_ID;

    // No metadata: allow only if there is nothing here that would be replied to.
    const hasMessages = Array.isArray(v?.messages) && v.messages.length > 0;
    return !hasMessages;
  });
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
