/**
 * Meta's webhook envelope -> a flat event the rest of the app can use.
 *
 * The envelope is deeply nested and every level is optional, so this module
 * assumes nothing and returns [] rather than throwing on a shape it does not
 * recognise. Status callbacks (delivered / read) arrive on the same endpoint
 * and are deliberately ignored here.
 *
 * So are messages for a different number. One Meta app can own several
 * WhatsApp numbers, and every one of them posts to the same callback URL - so
 * a message sent to a sibling product on the same app arrives here looking
 * perfectly valid. Without the metadata check below, this service would read
 * it, create a player, and reply from the wrong brand.
 */
import { config } from '../config/env.js';
import { log } from '../utils/logger.js';

/**
 * @returns {Array<{
 *   waMessageId: string, from: string, name: string|null,
 *   type: 'text'|'button_reply'|'list_reply'|'other',
 *   text: string, replyId: string|null, timestamp: string|null
 * }>}
 */
export function parseInbound(body) {
  const events = [];
  const entries = body?.entry;
  if (!Array.isArray(entries)) return events;

  for (const entry of entries) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      const messages = value?.messages;
      if (!Array.isArray(messages)) continue;

      // Whose number was this sent to?
      //
      // Compared as strings: Meta sends the id as a string, and an env file
      // that quotes it or leaves a trailing space would otherwise silently
      // discard every real message. Skipped entirely when the id is not
      // configured - a local setup with no WHATSAPP_PHONE_NUMBER_ID should
      // still receive its own test messages rather than drop all of them.
      const targetId = value?.metadata?.phone_number_id;
      const ownId = config.whatsapp.phoneNumberId;
      if (ownId && targetId && String(targetId).trim() !== String(ownId).trim()) {
        log.info('ignoring webhook for another number', {
          phone_number_id: String(targetId),
          ours: String(ownId),
          messages: messages.length,
        });
        continue;
      }

      // contacts[] carries the sender's WhatsApp profile name.
      const names = new Map();
      for (const c of value?.contacts ?? []) {
        if (c?.wa_id) names.set(c.wa_id, c?.profile?.name ?? null);
      }

      for (const message of messages) {
        const event = toEvent(message, names);
        if (event) events.push(event);
      }
    }
  }
  return events;
}

function toEvent(message, names) {
  const from = message?.from;
  const waMessageId = message?.id;
  if (!from || !waMessageId) return null;

  const base = {
    waMessageId,
    from: String(from),
    name: names.get(from) ?? null,
    timestamp: message?.timestamp ?? null,
    type: 'other',
    text: '',
    replyId: null,
  };

  switch (message.type) {
    case 'text':
      return { ...base, type: 'text', text: (message.text?.body ?? '').trim() };

    case 'interactive': {
      const interactive = message.interactive ?? {};
      if (interactive.type === 'button_reply') {
        return {
          ...base,
          type: 'button_reply',
          replyId: interactive.button_reply?.id ?? null,
          text: interactive.button_reply?.title ?? '',
        };
      }
      if (interactive.type === 'list_reply') {
        return {
          ...base,
          type: 'list_reply',
          replyId: interactive.list_reply?.id ?? null,
          text: interactive.list_reply?.title ?? '',
        };
      }
      return base;
    }

    // Quick-reply buttons on a template message come back as type "button".
    case 'button':
      return {
        ...base,
        type: 'button_reply',
        replyId: message.button?.payload ?? null,
        text: message.button?.text ?? '',
      };

    default:
      return base;
  }
}

/**
 * True when the payload is a delivery/read status callback rather than an
 * actual message. Worth checking so the logs are not full of "unhandled".
 */
export function isStatusCallback(body) {
  const changes = body?.entry?.[0]?.changes ?? [];
  return changes.some((c) => Array.isArray(c?.value?.statuses) && !c?.value?.messages);
}
