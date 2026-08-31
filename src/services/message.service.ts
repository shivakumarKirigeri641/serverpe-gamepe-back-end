import { query, queryOne } from '../db/pool.js';
import { logger } from '../utils/logger.js';
import type { InboundEvent, StatusEvent } from '../whatsapp/types.js';
import { EVENT, track } from './analytics.service.js';

/** Ranked so a late-arriving "sent" can never overwrite a "read". */
const STATUS_RANK: Record<string, number> = {
  accepted: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
};

/**
 * Records an inbound message with full attribution.
 *
 * `ON CONFLICT DO NOTHING` on the inbound unique index means Meta's retries
 * cannot create duplicate rows even if the Redis de-dup misses.
 */
export async function logInbound(
  event: InboundEvent,
  playerId: string | null,
  gameId: string | null,
): Promise<void> {
  const kind = event.flowResponse ? 'flow_reply' : event.actionId ? 'interactive' : 'text';

  try {
    await query(
      `INSERT INTO message_log
         (wa_id, player_id, game_id, direction, wa_message_id, kind, body, status, status_at, created_at)
       VALUES ($1, $2, $3, 'inbound', $4, $5, $6, 'received', now(), $7)
       ON CONFLICT DO NOTHING`,
      [
        event.waId,
        playerId,
        gameId,
        event.messageId,
        kind,
        JSON.stringify({
          text: event.text,
          actionId: event.actionId ?? null,
          flowToken: event.flowToken ?? null,
          flowResponse: event.flowResponse ?? null,
          profileName: event.profileName ?? null,
        }),
        event.receivedAt,
      ],
    );
  } catch (err) {
    logger.warn({ err, messageId: event.messageId }, 'failed to persist inbound message log');
  }

  await track({
    type: EVENT.MESSAGE_RECEIVED,
    source: 'whatsapp',
    waId: event.waId,
    playerId,
    gameId,
    properties: {
      kind,
      actionId: event.actionId ?? null,
      textLength: event.text.length,
      // Latency between the player pressing send and us processing it.
      lagMs: Date.now() - event.receivedAt.getTime(),
    },
  });
}

/**
 * Applies a delivery receipt to the message it refers to.
 *
 * Statuses arrive out of order surprisingly often, so the update is guarded by
 * rank — a "sent" that lands after a "read" is ignored rather than regressing
 * the row.
 */
export async function applyStatus(status: StatusEvent): Promise<void> {
  const rank = STATUS_RANK[status.status] ?? 1;

  const row = await queryOne<{ id: string; player_id: string | null; game_id: string | null }>(
    `UPDATE message_log
        SET status = $2,
            status_at = $3,
            delivered_at = CASE WHEN $2 = 'delivered' THEN $3 ELSE delivered_at END,
            read_at      = CASE WHEN $2 = 'read'      THEN $3 ELSE read_at END,
            failed_at    = CASE WHEN $2 = 'failed'    THEN $3 ELSE failed_at END,
            pricing_category = COALESCE($4, pricing_category),
            error_code       = COALESCE($5, error_code)
      WHERE wa_message_id = $1
        AND direction = 'outbound'
        AND COALESCE(
              CASE status
                WHEN 'accepted'  THEN 0
                WHEN 'sent'      THEN 1
                WHEN 'delivered' THEN 2
                WHEN 'read'      THEN 3
                WHEN 'failed'    THEN 4
                ELSE 0
              END, 0) <= $6
      RETURNING id, player_id, game_id`,
    [
      status.messageId,
      status.status,
      status.occurredAt,
      status.pricingCategory ?? null,
      status.errorCode ?? null,
      rank,
    ],
  );

  // A status for a message we never logged (sent before this deploy, or from
  // another system on the same number) is not an error worth shouting about.
  if (!row) return;

  const type =
    status.status === 'read'
      ? EVENT.MESSAGE_READ
      : status.status === 'delivered'
        ? EVENT.MESSAGE_DELIVERED
        : status.status === 'failed'
          ? EVENT.MESSAGE_FAILED
          : null;

  if (!type) return;

  await track({
    type,
    source: 'whatsapp',
    waId: status.waId,
    playerId: row.player_id,
    gameId: row.game_id,
    properties: {
      messageId: status.messageId,
      pricingCategory: status.pricingCategory ?? null,
      errorCode: status.errorCode ?? null,
      errorTitle: status.errorTitle ?? null,
    },
  });
}
