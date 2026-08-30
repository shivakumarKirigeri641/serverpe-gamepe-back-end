import { describe, expect, it } from 'vitest';
import { isForThisNumber } from '../src/whatsapp/verify.js';
import { env } from '../src/config/env.js';

/**
 * Webhook routing.
 *
 * Meta delivers by app-to-WABA subscription, not by phone number, so a payload
 * for a different number under the same account arrives here correctly signed
 * and otherwise indistinguishable from our own. The only thing that says who it
 * was for is metadata.phone_number_id.
 *
 * These tests exist because the consequence of getting it wrong is not a bug
 * report — it is a stranger receiving a message from a product they never
 * contacted. That must fail the build, not be discovered in production.
 */

const OURS = env.WHATSAPP_PHONE_NUMBER_ID;
const SOMEBODY_ELSE = '999999999999999';

const payload = (
  phoneNumberId: string | null,
  kind: 'messages' | 'statuses' | 'empty' = 'messages',
): unknown => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'waba-id',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            ...(phoneNumberId
              ? { metadata: { phone_number_id: phoneNumberId, display_phone_number: 'x' } }
              : {}),
            ...(kind === 'messages'
              ? { messages: [{ from: '910000000000', id: 'wamid.test', type: 'text', text: { body: 'hi' } }] }
              : {}),
            ...(kind === 'statuses'
              ? { statuses: [{ id: 'wamid.test', status: 'delivered', recipient_id: '910000000000' }] }
              : {}),
          },
        },
      ],
    },
  ],
});

describe('webhook is addressed to this number', () => {
  it('accepts a message for our own number', () => {
    expect(isForThisNumber(payload(OURS))).toBe(true);
  });

  it('rejects a message for another number on the same account', () => {
    expect(isForThisNumber(payload(SOMEBODY_ELSE))).toBe(false);
  });

  it('rejects a message whose target cannot be determined', () => {
    // Fails closed: answering somebody else's user is visible to them and
    // cannot be undone, while a dropped webhook is retried by Meta for hours.
    expect(isForThisNumber(payload(null, 'messages'))).toBe(false);
  });

  it('accepts a delivery receipt with no metadata', () => {
    // Nothing to reply to, and this is how we learn our own sends arrived.
    expect(isForThisNumber(payload(null, 'statuses'))).toBe(true);
  });

  it('rejects junk', () => {
    expect(isForThisNumber({})).toBe(false);
    expect(isForThisNumber(null)).toBe(false);
    expect(isForThisNumber({ entry: [] })).toBe(false);
    expect(isForThisNumber({ entry: [{ changes: [] }] })).toBe(false);
  });

  it('accepts a batch that contains our number alongside another', () => {
    // Meta can batch entries. Dropping the whole batch would lose our own
    // messages; the per-message routing downstream still sees only ours.
    const mixed = {
      entry: [
        ...(payload(SOMEBODY_ELSE) as { entry: unknown[] }).entry,
        ...(payload(OURS) as { entry: unknown[] }).entry,
      ],
    };
    expect(isForThisNumber(mixed)).toBe(true);
  });
});
