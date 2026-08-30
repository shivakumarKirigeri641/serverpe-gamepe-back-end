import { createHash } from 'node:crypto';
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

/**
 * A short, stable label derived from the player's id — never their number.
 *
 * The previous fallback used the last four digits of the phone number, which
 * meant a host could read part of a guest's number off the leaderboard. Four
 * digits is not the whole number, but it is still their number, and it is the
 * half that identifies them to anyone who already has the rest.
 *
 * Hashing the UUID gives the same label for the same person every time, so
 * players stay recognisable across a game, while revealing nothing.
 */
function anonymousTag(playerId: string): string {
  return createHash('sha256').update(playerId).digest('hex').slice(0, 4).toUpperCase();
}

/**
 * What OTHER players are allowed to see.
 *
 * Their WhatsApp profile name if they have one — they chose to publish that —
 * otherwise an anonymous tag. Never any part of a phone number.
 */
export function displayNameOf(player: { id: string; display_name: string | null }): string {
  return player.display_name?.trim() || `Player ${anonymousTag(player.id)}`;
}

/** The same rule, for rows that are not full PlayerRows. */
export function publicName(playerId: string, displayName?: string | null): string {
  return displayName?.trim() || `Player ${anonymousTag(playerId)}`;
}

export async function findPlayerById(id: string, client?: Queryable): Promise<PlayerRow | null> {
  return queryOne<PlayerRow>(
    'SELECT id, wa_id, display_name, locale, is_blocked, false AS is_new FROM players WHERE id = $1',
    [id],
    client,
  );
}
