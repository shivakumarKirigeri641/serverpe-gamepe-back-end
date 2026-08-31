import { query, type Queryable } from '../db/pool.js';
import { logger } from '../utils/logger.js';

/**
 * Every tracked event type. Keep this list closed — a typo'd string is a
 * silently missing metric, and the admin panel builds its filters from here.
 */
export const EVENT = {
  // player lifecycle
  PLAYER_CREATED: 'player.created',
  PLAYER_RETURNED: 'player.returned',

  // messaging
  MESSAGE_RECEIVED: 'message.received',
  MESSAGE_SENT: 'message.sent',
  MESSAGE_FAILED: 'message.failed',
  MESSAGE_DELIVERED: 'message.delivered',
  MESSAGE_READ: 'message.read',
  MESSAGE_DUPLICATE_IGNORED: 'message.duplicate_ignored',

  // navigation
  MENU_SHOWN: 'menu.shown',
  HELP_SHOWN: 'help.shown',
  COMMAND_UNRECOGNISED: 'command.unrecognised',

  // game lifecycle
  GAME_CREATED: 'game.created',
  GAME_JOINED: 'game.joined',
  GAME_JOIN_FAILED: 'game.join_failed',
  GAME_LEFT: 'game.left',
  GAME_STARTED: 'game.started',
  GAME_DRAW: 'game.draw',
  GAME_ACK: 'game.ack',
  GAME_TICK_EARLY_ADVANCE: 'game.tick_early_advance',
  GAME_COMPLETED: 'game.completed',
  GAME_ABANDONED: 'game.abandoned',

  // claims
  CLAIM_AWARDED: 'claim.awarded',
  CLAIM_REJECTED: 'claim.rejected',

  // money (dormant during the free trial)
  WALLET_DEBITED: 'wallet.debited',
  WALLET_CREDITED: 'wallet.credited',

  // feedback
  FEEDBACK_PROMPTED: 'feedback.prompted',
  FEEDBACK_RATED: 'feedback.rated',
  FEEDBACK_COMMENTED: 'feedback.commented',
  PROMO_SHOWN: 'promo.shown',

  // moderation
  PLAYER_BLOCKED: 'player.blocked',
  PLAYER_UNBLOCKED: 'player.unblocked',
  BLOCKED_ATTEMPT: 'player.blocked_attempt',

  // web board
  BOARD_OPENED: 'board.opened',

  // legal / consent
  CONSENT_PROMPTED: 'consent.prompted',
  CONSENT_DOCUMENT_OPENED: 'consent.document_opened',
  CONSENT_ACCEPTED: 'consent.accepted',
  CONSENT_DECLINED: 'consent.declined',

  // ops
  ADMIN_REQUEST: 'admin.request',
  ROLLUP_COMPUTED: 'rollup.computed',
  ARCHIVE_SWEEP: 'archive.sweep',
  ERROR: 'error',
} as const;

export type EventType = (typeof EVENT)[keyof typeof EVENT];
export type EventSource = 'whatsapp' | 'worker' | 'admin' | 'web' | 'system';

export interface TrackInput {
  type: EventType;
  playerId?: string | null;
  gameId?: string | null;
  waId?: string | null;
  source?: EventSource;
  properties?: Record<string, unknown>;
  /** HTTP-only. WhatsApp players have neither. */
  requestIp?: string | null;
  userAgent?: string | null;
  adminActor?: string | null;
}

/**
 * Records one event. Deliberately never throws: analytics must not be able to
 * break a game. A failure here is logged and swallowed.
 */
export async function track(input: TrackInput, client?: Queryable): Promise<void> {
  try {
    await query(
      `INSERT INTO analytics_events
         (event_type, player_id, game_id, wa_id, source, properties, request_ip, user_agent, admin_actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.type,
        input.playerId ?? null,
        input.gameId ?? null,
        input.waId ?? null,
        input.source ?? 'system',
        JSON.stringify(input.properties ?? {}),
        input.requestIp ?? null,
        input.userAgent ?? null,
        input.adminActor ?? null,
      ],
      client,
    );
  } catch (err) {
    logger.warn({ err, eventType: input.type }, 'failed to record analytics event');
  }
}

/** Fire-and-forget for hot paths like the per-number fan-out. */
export function trackAsync(input: TrackInput): void {
  void track(input);
}
