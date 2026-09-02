/**
 * Outbound WhatsApp.
 *
 * Two safety properties matter more than anything else here:
 *
 *   1. With no access token, nothing is sent - messages are logged instead.
 *      A whole round is playable with no Meta account attached.
 *   2. With WHATSAPP_ALLOWED_RECIPIENTS set, a message to any other number is
 *      dropped. While testing against a live token this is the difference
 *      between a bug and a bug that texts strangers.
 */
import { config } from '../config/env.js';
import { log } from '../utils/logger.js';

const MAX_BUTTONS = 3;      // hard WhatsApp limit
const MAX_BUTTON_TITLE = 20;
const MAX_BODY = 1024;

/**
 * Test hook. When set, outbound messages go here instead of to Meta or the
 * log, which is how src/temp/simulate-flow.js can show a whole conversation.
 * Production never touches this.
 */
let outboundSink = null;

export function setOutboundSink(fn) {
  outboundSink = fn;
}

/**
 * Called after every outbound attempt with its outcome, so the conversation
 * log records whether a message actually landed. Wired up in index.js rather
 * than imported here - this module has no business knowing about the database.
 */
let outboundRecorder = null;

export function setOutboundRecorder(fn) {
  outboundRecorder = fn;
}

function record(to, payload, describe, result) {
  if (!outboundRecorder) return;
  try {
    outboundRecorder({ to, payload, describe, result });
  } catch {
    /* logging must never break sending */
  }
}

function apiUrl() {
  return `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/messages`;
}

function allowed(to) {
  const list = config.whatsapp.allowedRecipients;
  if (list.length === 0) return true;
  return list.includes(String(to));
}

async function send(payload, describe) {
  const to = payload.to;

  if (outboundSink) {
    outboundSink({ to, payload, describe });
    return { sent: false, captured: true };
  }

  if (!allowed(to)) {
    // Loud and actionable on purpose. A silently dropped reply looks exactly
    // like a broken bot from the player's side, and the operator has no way to
    // tell the difference without being told what to change.
    log.warn(
      `outbound DROPPED - ${to} is not in WHATSAPP_ALLOWED_RECIPIENTS. ` +
        `Add it to .env and restart, or clear the variable to allow everyone.`,
      { to, describe },
    );
    const result = { sent: false, blocked: true, status: 'blocked' };
    record(to, payload, describe, result);
    return result;
  }

  if (!config.whatsapp.live) {
    log.info(`[dry run] -> ${to}: ${describe}`);
    const result = { sent: false, dryRun: true, status: 'dry_run' };
    record(to, payload, describe, result);
    return result;
  }

  try {
    const res = await fetch(apiUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.whatsapp.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Meta's error bodies are where the real reason lives - surface it
      // rather than just the status code.
      log.error('whatsapp send failed', {
        to,
        status: res.status,
        error: json?.error?.message ?? json,
      });
      const failed = {
        sent: false, status: 'failed',
        error: json?.error?.message ?? `HTTP ${res.status}`,
      };
      record(to, payload, describe, failed);
      return failed;
    }
    const sent = { sent: true, status: 'sent', waMessageId: json?.messages?.[0]?.id ?? null };
    record(to, payload, describe, sent);
    return sent;
  } catch (err) {
    log.error('whatsapp send threw', { to, message: err.message });
    const failed = { sent: false, status: 'failed', error: err.message };
    record(to, payload, describe, failed);
    return failed;
  }
}

export function sendText(to, body) {
  return send(
    { messaging_product: 'whatsapp', to, type: 'text', text: { preview_url: true, body: clamp(body, MAX_BODY) } },
    `text: ${oneLine(body)}`,
  );
}

/**
 * Up to three reply buttons. Anything more has to be a list, so callers get a
 * loud error rather than a silently truncated menu.
 */
export function sendButtons(to, body, buttons, { header, footer } = {}) {
  if (buttons.length > MAX_BUTTONS) {
    throw new Error(`WhatsApp allows at most ${MAX_BUTTONS} buttons, got ${buttons.length} - use sendList`);
  }
  const interactive = {
    type: 'button',
    body: { text: clamp(body, MAX_BODY) },
    action: {
      buttons: buttons.map((b) => ({
        type: 'reply',
        reply: { id: b.id, title: clamp(b.title, MAX_BUTTON_TITLE) },
      })),
    },
  };
  if (header) interactive.header = { type: 'text', text: clamp(header, 60) };
  if (footer) interactive.footer = { text: clamp(footer, 60) };

  return send(
    { messaging_product: 'whatsapp', to, type: 'interactive', interactive },
    `buttons [${buttons.map((b) => b.title).join(' | ')}]: ${oneLine(body)}`,
  );
}

/** A list menu - up to 10 rows, for when three buttons are not enough. */
export function sendList(to, body, { buttonText = 'Choose', sections, header, footer }) {
  const interactive = {
    type: 'list',
    body: { text: clamp(body, MAX_BODY) },
    action: { button: clamp(buttonText, MAX_BUTTON_TITLE), sections },
  };
  if (header) interactive.header = { type: 'text', text: clamp(header, 60) };
  if (footer) interactive.footer = { text: clamp(footer, 60) };

  return send(
    { messaging_product: 'whatsapp', to, type: 'interactive', interactive },
    `list: ${oneLine(body)}`,
  );
}

/** A button that opens a URL - how a player gets from WhatsApp to the board. */
export function sendCtaUrl(to, body, { displayText, url, header, footer }) {
  const interactive = {
    type: 'cta_url',
    body: { text: clamp(body, MAX_BODY) },
    action: { name: 'cta_url', parameters: { display_text: clamp(displayText, MAX_BUTTON_TITLE), url } },
  };
  if (header) interactive.header = { type: 'text', text: clamp(header, 60) };
  if (footer) interactive.footer = { text: clamp(footer, 60) };

  return send(
    { messaging_product: 'whatsapp', to, type: 'interactive', interactive },
    `cta "${displayText}" -> ${url}`,
  );
}

function clamp(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function oneLine(text) {
  return clamp(String(text ?? '').replace(/\s+/g, ' '), 120);
}

/**
 * Sends an approved message template.
 *
 * This is the ONLY way to reach a player who has not messaged us in the last
 * 24 hours — a plain text send to them is silently rejected by Meta. Used for
 * the "we are back online" announcement after maintenance, where by definition
 * nobody has been in touch for hours.
 */
export function sendTemplate(to, name, params = [], language = 'en') {
  return send(
    {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name,
        language: { code: language },
        // A body with no variables must omit `components` entirely; Meta
        // rejects an empty parameters array.
        ...(params.length
          ? {
              components: [{
                type: 'body',
                parameters: params.map((text) => ({ type: 'text', text: String(text) })),
              }],
            }
          : {}),
      },
    },
    `template ${name}(${params.join(', ')})`,
  );
}
