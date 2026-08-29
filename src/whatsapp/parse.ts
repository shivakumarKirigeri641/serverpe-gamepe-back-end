import type { InboundEvent, StatusEvent, WhatsAppWebhookBody } from './types.js';

/** Flattens Meta's nested webhook envelope into the events we care about. */
export function parseWebhook(body: WhatsAppWebhookBody): InboundEvent[] {
  const events: InboundEvent[] = [];

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const nameByWaId = new Map<string, string>();
      for (const contact of value.contacts ?? []) {
        if (contact.profile?.name) nameByWaId.set(contact.wa_id, contact.profile.name);
      }

      for (const message of value.messages ?? []) {
        const receivedAt = new Date(Number(message.timestamp) * 1000);
        const base = {
          waId: message.from,
          messageId: message.id,
          profileName: nameByWaId.get(message.from),
          receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
        };

        if (message.type === 'text' && 'text' in message) {
          events.push({ ...base, text: message.text.body.trim() });
          continue;
        }

        if (message.type === 'interactive' && 'interactive' in message) {
          const i = message.interactive;
          if (i.type === 'button_reply') {
            events.push({ ...base, text: i.button_reply.title, actionId: i.button_reply.id });
          } else if (i.type === 'list_reply') {
            events.push({ ...base, text: i.list_reply.title, actionId: i.list_reply.id });
          } else {
            // Flow submission: answers arrive as a JSON string.
            let flowResponse: Record<string, unknown> = {};
            try {
              flowResponse = JSON.parse(i.nfm_reply.response_json) as Record<string, unknown>;
            } catch {
              flowResponse = {};
            }
            events.push({
              ...base,
              text: '',
              flowToken:
                typeof flowResponse['flow_token'] === 'string'
                  ? (flowResponse['flow_token'] as string)
                  : undefined,
              flowResponse,
            });
          }
          continue;
        }

        // Media, reactions, locations: acknowledged, but the player needs
        // telling that we cannot act on them.
        events.push({ ...base, text: '', unsupportedType: message.type });
      }
    }
  }

  return events;
}

/**
 * Delivery receipts. Meta sends these on a separate change from messages, and
 * they are the only real signal that a player's phone actually received a
 * number - as opposed to us having merely handed it to Meta.
 */
export function parseStatuses(body: WhatsAppWebhookBody): StatusEvent[] {
  const events: StatusEvent[] = [];

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const status of change.value.statuses ?? []) {
        const seconds = Number(status.timestamp);
        const occurredAt = Number.isNaN(seconds) ? new Date() : new Date(seconds * 1000);
        const firstError = status.errors?.[0];

        events.push({
          messageId: status.id,
          status: status.status,
          waId: status.recipient_id,
          occurredAt,
          pricingCategory: status.pricing?.category,
          errorCode: firstError?.code,
          errorTitle: firstError?.title,
        });
      }
    }
  }

  return events;
}
