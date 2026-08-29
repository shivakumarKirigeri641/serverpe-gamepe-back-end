import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { query } from '../db/pool.js';
import { EVENT, trackAsync } from '../services/analytics.service.js';
import { mergeContext } from '../utils/context.js';
import type { ListRow, ReplyButton } from './types.js';

const GRAPH_BASE = 'https://graph.facebook.com';

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Attribution carried alongside a send so the message log can answer
 * "show me every message in room G7KGK3" without guessing by timestamp.
 */
export interface MessageContext {
  playerId?: string;
  gameId?: string;
  drawSeq?: number;
}

/**
 * Numbers this instance is permitted to message. Empty means no restriction.
 * Parsed once, not per send.
 */
const ALLOWED_RECIPIENTS = new Set(
  env.WHATSAPP_ALLOWED_RECIPIENTS.split(',')
    .map((n) => n.trim().replace(/[^0-9]/g, ''))
    .filter(Boolean),
);

/** Blocks a send to any number outside the whitelist, when one is configured. */
function isRecipientAllowed(waId: string): boolean {
  if (ALLOWED_RECIPIENTS.size === 0) return true;
  return ALLOWED_RECIPIENTS.has(waId.replace(/[^0-9]/g, ''));
}

function endpoint(): string {
  return `${GRAPH_BASE}/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
}

/** WhatsApp truncates hard; trim before it does so we control where. */
function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

async function logOutbound(
  waId: string,
  kind: string,
  body: unknown,
  result: SendResult,
  explicitCtx?: MessageContext,
): Promise<void> {
  const ctx = mergeContext(explicitCtx);

  try {
    await query(
      `INSERT INTO message_log
         (wa_id, player_id, game_id, draw_seq, direction, wa_message_id, kind, body, error, status, status_at, failed_at)
       VALUES ($1, $2, $3, $4, 'outbound', $5, $6, $7, $8, $9, now(), $10)`,
      [
        waId,
        ctx?.playerId ?? null,
        ctx?.gameId ?? null,
        ctx?.drawSeq ?? null,
        result.messageId ?? null,
        kind,
        JSON.stringify(body),
        result.error ?? null,
        result.ok ? 'accepted' : 'failed',
        result.ok ? null : new Date(),
      ],
    );
  } catch (err) {
    logger.warn({ err }, 'failed to persist outbound message log');
  }

  trackAsync({
    type: result.ok ? EVENT.MESSAGE_SENT : EVENT.MESSAGE_FAILED,
    source: 'whatsapp',
    waId,
    playerId: ctx?.playerId ?? null,
    gameId: ctx?.gameId ?? null,
    properties: {
      kind,
      drawSeq: ctx?.drawSeq ?? null,
      messageId: result.messageId ?? null,
      error: result.error ?? null,
    },
  });
}

const MAX_SEND_ATTEMPTS = 4;

/**
 * Meta error codes that mean "you are going too fast" rather than "this message
 * is wrong". Only these are worth retrying — a bad recipient or a malformed
 * payload will fail identically however many times we try.
 */
const RATE_LIMIT_CODES = new Set([
  4, // application request limit reached
  80007, // rate limit issues
  130429, // cloud api message throughput reached
  131048, // spam rate limit hit
  131056, // pair rate limit (too many messages to one recipient)
  133016, // too many requests, business account restricted
]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Exponential backoff with full jitter. Jitter matters here: a draw fans out to
 * every player at once, so without it a rate limit would make the whole room
 * retry in lockstep and hit the limit again together.
 */
function backoffDelay(attempt: number, retryAfterHeader?: string | null): number {
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 30_000);

  const ceiling = Math.min(1000 * 2 ** (attempt - 1), 8000);
  return Math.floor(ceiling / 2 + Math.random() * (ceiling / 2));
}

async function post(
  waId: string,
  kind: string,
  payload: Record<string, unknown>,
  ctx?: MessageContext,
): Promise<SendResult> {
  const body = { messaging_product: 'whatsapp', recipient_type: 'individual', to: waId, ...payload };

  if (!isRecipientAllowed(waId)) {
    // A guard, not an error: a development instance with a live token must not
    // be able to message a number a test fixture made up.
    logger.warn({ waId, kind }, 'recipient not in WHATSAPP_ALLOWED_RECIPIENTS, send blocked');
    const blocked: SendResult = { ok: false, error: 'recipient not allowed by WHATSAPP_ALLOWED_RECIPIENTS' };
    await logOutbound(waId, kind, body, blocked, ctx);
    return blocked;
  }

  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    // Local development without Meta credentials: log instead of sending so the
    // whole game loop stays exercisable offline.
    logger.info({ waId, kind, body }, '[whatsapp:dry-run] outbound message');
    const dryRun: SendResult = { ok: true, messageId: `dry-run-${Date.now()}` };
    await logOutbound(waId, kind, body, dryRun, ctx);
    return dryRun;
  }

  let lastError = 'send failed';

  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(endpoint(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const json = (await res.json().catch(() => ({}))) as {
        messages?: Array<{ id: string }>;
        error?: { message?: string; code?: number };
      };

      if (res.ok) {
        const result: SendResult = { ok: true, messageId: json.messages?.[0]?.id };
        await logOutbound(waId, kind, body, result, ctx);
        return result;
      }

      const code = json.error?.code;
      lastError = json.error?.message ?? `HTTP ${res.status}`;

      // 429 and 5xx are transient; so are Meta's own throttling codes.
      const retryable =
        res.status === 429 || res.status >= 500 || (code !== undefined && RATE_LIMIT_CODES.has(code));

      if (!retryable || attempt === MAX_SEND_ATTEMPTS) {
        logger.error({ waId, kind, code, status: res.status, error: lastError, attempt }, 'whatsapp send failed');
        const result: SendResult = { ok: false, error: lastError };
        await logOutbound(waId, kind, body, result, ctx);
        return result;
      }

      const delay = backoffDelay(attempt, res.headers.get('retry-after'));
      logger.warn(
        { waId, kind, code, status: res.status, attempt, delayMs: delay },
        'whatsapp rate limited, backing off',
      );
      await sleep(delay);
    } catch (err) {
      // Network-level failure: also worth retrying.
      lastError = err instanceof Error ? err.message : String(err);

      if (attempt === MAX_SEND_ATTEMPTS) {
        logger.error({ waId, kind, err }, 'whatsapp send threw');
        const result: SendResult = { ok: false, error: lastError };
        await logOutbound(waId, kind, body, result, ctx);
        return result;
      }

      const delay = backoffDelay(attempt);
      logger.warn({ waId, kind, attempt, delayMs: delay, err }, 'whatsapp send failed, retrying');
      await sleep(delay);
    }
  }

  const result: SendResult = { ok: false, error: lastError };
  await logOutbound(waId, kind, body, result, ctx);
  return result;
}

export function sendText(waId: string, text: string, ctx?: MessageContext): Promise<SendResult> {
  return post(waId, 'text', { type: 'text', text: { preview_url: false, body: clamp(text, 4096) } }, ctx);
}

/** Cloud API allows at most 3 reply buttons. */
export function sendButtons(
  waId: string,
  body: string,
  buttons: ReplyButton[],
  ctx?: MessageContext,
): Promise<SendResult> {
  return post(
    waId,
    'buttons',
    {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: clamp(body, 1024) },
        action: {
          buttons: buttons.slice(0, 3).map((b) => ({
            type: 'reply',
            reply: { id: clamp(b.id, 256), title: clamp(b.title, 20) },
          })),
        },
      },
    },
    ctx,
  );
}

/** Cloud API allows at most 10 rows across all sections. */
export function sendList(
  waId: string,
  body: string,
  buttonLabel: string,
  rows: ListRow[],
  sectionTitle = 'Options',
  ctx?: MessageContext,
): Promise<SendResult> {
  return post(
    waId,
    'list',
    {
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: clamp(body, 1024) },
        action: {
          button: clamp(buttonLabel, 20),
          sections: [
            {
              title: clamp(sectionTitle, 24),
              rows: rows.slice(0, 10).map((r) => ({
                id: clamp(r.id, 200),
                title: clamp(r.title, 24),
                ...(r.description ? { description: clamp(r.description, 72) } : {}),
              })),
            },
          ],
        },
      },
    },
    ctx,
  );
}

/**
 * Fan-out helper for draw broadcasts. Sent with limited concurrency to stay
 * inside the Cloud API's per-second throughput.
 */
export async function broadcastText(waIds: string[], text: string, concurrency = 10): Promise<void> {
  for (let i = 0; i < waIds.length; i += concurrency) {
    const batch = waIds.slice(i, i + concurrency);
    await Promise.all(batch.map((waId) => sendText(waId, text)));
  }
}

/**
 * Screen data for the shared in-game Flow. Field names are deliberately
 * game-neutral: "board" not "ticket", "call" not "number", so a future game
 * reuses the same published Flow without a new definition.
 */
export interface GameFlowScreenData {
  call_label: string;
  progress_label: string;
  board_text: string;
  question_label: string;
  claim_options: Array<{ id: string; title: string }>;
}

export function isFlowConfigured(): boolean {
  return Boolean(env.WHATSAPP_FLOW_ID);
}

/**
 * Sends the in-game board screen as a WhatsApp Flow.
 *
 * Uses "navigate" with the screen data supplied up front, which is the
 * endpoint-less Flow model: no data-exchange server, no RSA key exchange. The
 * player's answers come back through the normal webhook as an `nfm_reply`.
 *
 * `flowToken` correlates the reply with the game and draw sequence it answers.
 */
export function sendGameFlow(
  waId: string,
  flowToken: string,
  bodyText: string,
  data: GameFlowScreenData,
  ctaLabel = 'Open my board',
  ctx?: MessageContext,
): Promise<SendResult> {
  return post(
    waId,
    'flow',
    {
      type: 'interactive',
      interactive: {
        type: 'flow',
        body: { text: clamp(bodyText, 1024) },
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_token: flowToken,
            flow_id: env.WHATSAPP_FLOW_ID,
            flow_cta: clamp(ctaLabel, 20),
            flow_action: 'navigate',
            flow_action_payload: { screen: 'BOARD', data },
          },
        },
      },
    },
    ctx,
  );
}

/* -------------------------------------------------------------------- media */

/**
 * Uploads an image to Meta and returns a media id.
 *
 * Uploading beats sending a public link: the ticket is a player's private
 * board, and a link would have to be reachable by anyone who guessed the URL.
 * Media ids are valid for 30 days, far longer than a round.
 */
export async function uploadMedia(
  bytes: Buffer,
  mimeType = 'image/png',
  filename = 'ticket.png',
): Promise<string | null> {
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    logger.debug({ size: bytes.length }, '[whatsapp:dry-run] media upload');
    return `dry-run-media-${Date.now()}`;
  }

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);

  try {
    const res = await fetch(
      `${GRAPH_BASE}/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/media`,
      { method: 'POST', headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` }, body: form },
    );
    const json = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };

    if (!res.ok || !json.id) {
      logger.error({ status: res.status, error: json.error?.message }, 'media upload failed');
      return null;
    }
    return json.id;
  } catch (err) {
    logger.error({ err }, 'media upload threw');
    return null;
  }
}

/** Sends a previously uploaded image, with an optional caption. */
export function sendImage(
  waId: string,
  mediaId: string,
  caption?: string,
  ctx?: MessageContext,
): Promise<SendResult> {
  return post(
    waId,
    'image',
    {
      type: 'image',
      image: { id: mediaId, ...(caption ? { caption: clamp(caption, 1024) } : {}) },
    },
    ctx,
  );
}

/**
 * A message with a single "open this link" button.
 *
 * This is how a player reaches the web board: WhatsApp renders a proper button
 * rather than a bare URL, and the link opens in the phone's browser.
 */
export function sendCtaUrl(
  waId: string,
  bodyText: string,
  buttonText: string,
  url: string,
  ctx?: MessageContext,
  footer?: string,
): Promise<SendResult> {
  return post(
    waId,
    'cta_url',
    {
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        body: { text: clamp(bodyText, 1024) },
        ...(footer ? { footer: { text: clamp(footer, 60) } } : {}),
        action: {
          name: 'cta_url',
          parameters: { display_text: clamp(buttonText, 20), url },
        },
      },
    },
    ctx,
  );
}

/** Sends a previously uploaded document (a PDF report, for instance). */
export function sendDocument(
  waId: string,
  mediaId: string,
  filename: string,
  caption?: string,
  ctx?: MessageContext,
): Promise<SendResult> {
  return post(
    waId,
    'document',
    {
      type: 'document',
      document: {
        id: mediaId,
        filename: clamp(filename, 240),
        ...(caption ? { caption: clamp(caption, 1024) } : {}),
      },
    },
    ctx,
  );
}
