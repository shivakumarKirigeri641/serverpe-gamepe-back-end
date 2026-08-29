import { queryOne, type Queryable } from '../db/pool.js';

export interface PlayerRow {
  id: string;
  wa_id: string;
  display_name: string | null;
  locale: string;
  is_blocked: boolean;
  /** True only on the very first message this number ever sent us. */
  is_new: boolean;
}

/**
 * Every inbound message resolves to a player row; the first message a number
 * ever sends creates it, along with an empty wallet.
 */
export async function upsertPlayer(
  waId: string,
  displayName?: string,
  client?: Queryable,
): Promise<PlayerRow> {
  const player = await queryOne<PlayerRow>(
    `INSERT INTO players (wa_id, display_name)
     VALUES ($1, $2)
     ON CONFLICT (wa_id) DO UPDATE
       SET display_name = COALESCE(EXCLUDED.display_name, players.display_name),
           last_seen_at = now()
     RETURNING id, wa_id, display_name, locale, is_blocked,
               (xmax = 0) AS is_new`,
    [waId, displayName ?? null],
    client,
  );
  if (!player) throw new Error(`Failed to upsert player ${waId}`);

  await queryOne(
    `INSERT INTO wallets (player_id) VALUES ($1) ON CONFLICT (player_id) DO NOTHING`,
    [player.id],
    client,
  );

  return player;
}

export function displayNameOf(player: PlayerRow): string {
  return player.display_name?.trim() || `Player ${player.wa_id.slice(-4)}`;
}

export async function findPlayerById(id: string, client?: Queryable): Promise<PlayerRow | null> {
  return queryOne<PlayerRow>(
    'SELECT id, wa_id, display_name, locale, is_blocked, false AS is_new FROM players WHERE id = $1',
    [id],
    client,
  );
}
