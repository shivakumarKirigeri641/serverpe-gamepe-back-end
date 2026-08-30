import { query, queryOne, withTransaction } from '../db/pool.js';
import { redis } from '../redis/client.js';
import { logger } from '../utils/logger.js';
import { notify } from './notification.service.js';
import { EVENT, track } from './analytics.service.js';

/**
 * Blocking numbers.
 *
 * The blocklist is keyed on the WhatsApp number rather than the player row, so
 * a block survives the player record being deleted and still applies if the
 * same number comes back. It is cached in Redis because it is consulted on
 * every single inbound message.
 */

const CACHE_KEY = 'moderation:blocked';
const CACHE_TTL_SECONDS = 300;

export interface BlockInput {
  waId: string;
  reason: string;
  category?: string;
  performedBy: string;
  reportedBy?: string;
}

async function invalidateCache(): Promise<void> {
  try {
    await redis.del(CACHE_KEY);
  } catch (err) {
    logger.warn({ err }, 'could not clear the blocklist cache');
  }
}

/**
 * Is this number blocked?
 *
 * Called for every inbound message, so the answer is cached. On a Redis failure
 * it falls through to the database rather than letting a blocked number in —
 * failing open here would defeat the point.
 */
export async function isBlocked(waId: string): Promise<boolean> {
  try {
    const cached = await redis.sismember(CACHE_KEY, waId);
    if (cached === 1) return true;
    if (await redis.exists(CACHE_KEY)) return false;
  } catch {
    // fall through to the database
  }

  const row = await queryOne<{ wa_id: string }>('SELECT wa_id FROM blocked_numbers WHERE wa_id = $1', [
    waId,
  ]);

  // Warm the cache for the next message.
  void refreshCache();
  return Boolean(row);
}

async function refreshCache(): Promise<void> {
  try {
    const rows = await query<{ wa_id: string }>('SELECT wa_id FROM blocked_numbers');
    const pipeline = redis.pipeline();
    pipeline.del(CACHE_KEY);
    if (rows.length > 0) pipeline.sadd(CACHE_KEY, ...rows.map((r) => r.wa_id));
    // An empty set would not exist in Redis, so mark it explicitly.
    pipeline.sadd(CACHE_KEY, '__none__');
    pipeline.expire(CACHE_KEY, CACHE_TTL_SECONDS);
    await pipeline.exec();
  } catch (err) {
    logger.warn({ err }, 'could not refresh the blocklist cache');
  }
}

export async function blockNumber(input: BlockInput): Promise<Record<string, unknown> | null> {
  const result = await withTransaction(async (client) => {
    const player = await queryOne<{ id: string }>('SELECT id FROM players WHERE wa_id = $1', [input.waId], client);

    await query(
      `INSERT INTO blocked_numbers (wa_id, reason, category, blocked_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (wa_id) DO UPDATE
         SET reason = EXCLUDED.reason, category = EXCLUDED.category,
             blocked_by = EXCLUDED.blocked_by, blocked_at = now()`,
      [input.waId, input.reason.slice(0, 500), input.category ?? null, input.performedBy],
      client,
    );

    if (player) {
      await query(
        `UPDATE players
            SET is_blocked = true, blocked_at = now(),
                blocked_reason = $2, blocked_by = $3
          WHERE id = $1`,
        [player.id, input.reason.slice(0, 500), input.performedBy],
        client,
      );

      // Take them out of anything in progress — a blocked player must not keep
      // receiving numbers for a game they were already in.
      await query(
        `UPDATE game_players SET left_at = now()
          WHERE player_id = $1 AND left_at IS NULL`,
        [player.id],
        client,
      );
    }

    await query(
      `INSERT INTO player_blocks (player_id, wa_id, action, reason, category, performed_by, reported_by)
       VALUES ($1, $2, 'block', $3, $4, $5, $6)`,
      [
        player?.id ?? null,
        input.waId,
        input.reason.slice(0, 500),
        input.category ?? null,
        input.performedBy,
        input.reportedBy ?? null,
      ],
      client,
    );

    return { waId: input.waId, playerId: player?.id ?? null, blocked: true };
  });

  await invalidateCache();
  await track({
    type: EVENT.PLAYER_BLOCKED,
    source: 'admin',
    waId: input.waId,
    playerId: (result.playerId as string) ?? null,
    adminActor: input.performedBy,
    properties: { reason: input.reason, category: input.category ?? null },
  });

  logger.warn({ waId: input.waId, by: input.performedBy }, 'number blocked');

  void notify({
    trigger: 'player.blocked',
    summary: `+${input.waId} blocked by ${input.performedBy} — ${input.reason.slice(0, 120)}`,
    waId: input.waId,
    detail: {
      reason: input.reason.slice(0, 500),
      category: input.category ?? null,
      reportedBy: input.reportedBy ?? null,
      performedBy: input.performedBy,
    },
  });

  return result;
}

export async function unblockNumber(
  waId: string,
  reason: string,
  performedBy: string,
): Promise<Record<string, unknown>> {
  const result = await withTransaction(async (client) => {
    await query('DELETE FROM blocked_numbers WHERE wa_id = $1', [waId], client);

    const player = await queryOne<{ id: string }>('SELECT id FROM players WHERE wa_id = $1', [waId], client);
    if (player) {
      await query(
        `UPDATE players SET is_blocked = false, blocked_at = NULL,
                            blocked_reason = NULL, blocked_by = NULL
          WHERE id = $1`,
        [player.id],
        client,
      );
    }

    await query(
      `INSERT INTO player_blocks (player_id, wa_id, action, reason, performed_by)
       VALUES ($1, $2, 'unblock', $3, $4)`,
      [player?.id ?? null, waId, reason.slice(0, 500), performedBy],
      client,
    );

    return { waId, playerId: player?.id ?? null, blocked: false };
  });

  await invalidateCache();
  await track({
    type: EVENT.PLAYER_UNBLOCKED,
    source: 'admin',
    waId,
    adminActor: performedBy,
    properties: { reason },
  });

  return result;
}

/** Marks that the player has been told they are blocked. */
export async function markBlockNotified(waId: string): Promise<void> {
  await query('UPDATE blocked_numbers SET notified_at = now() WHERE wa_id = $1 AND notified_at IS NULL', [
    waId,
  ]);
}

export async function needsBlockNotice(waId: string): Promise<boolean> {
  const row = await queryOne<{ wa_id: string }>(
    'SELECT wa_id FROM blocked_numbers WHERE wa_id = $1 AND notified_at IS NULL',
    [waId],
  );
  return Boolean(row);
}

export async function listBlocked(limit: number, offset: number): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT b.wa_id, b.reason, b.category, b.blocked_by, b.blocked_at, b.notified_at,
            p.id AS player_id, p.display_name,
            (SELECT count(*)::int FROM games g WHERE g.host_player_id = p.id) AS games_hosted
       FROM blocked_numbers b
       LEFT JOIN players p ON p.wa_id = b.wa_id
      ORDER BY b.blocked_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
}

export async function blockHistory(waId: string): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT action, reason, category, performed_by, reported_by, created_at
       FROM player_blocks WHERE wa_id = $1 ORDER BY created_at DESC`,
    [waId],
  );
}
