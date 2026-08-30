import { query, queryOne, withTransaction, type Queryable } from '../db/pool.js';
import { isChargingEnabled } from '../config/env.js';

export type LedgerKind =
  | 'topup'
  | 'game_charge'
  | 'entry_fee'
  | 'prize'
  | 'refund'
  | 'goodwill'
  | 'promo_credit'
  | 'adjustment';

export interface LedgerEntry {
  playerId: string;
  amountPaise: number; // positive credit, negative debit
  kind: LedgerKind;
  referenceType?: string;
  referenceId?: string;
  idempotencyKey?: string;
  /** Why this movement happened — shown in the admin panel and to support. */
  note?: string;
  /** Which admin made it, for anything not driven by gameplay. */
  createdBy?: string;
}

export async function getBalance(playerId: string, client?: Queryable): Promise<number> {
  const row = await queryOne<{ balance_paise: string }>(
    'SELECT balance_paise FROM wallets WHERE player_id = $1',
    [playerId],
    client,
  );
  return row ? Number(row.balance_paise) : 0;
}

/**
 * Single entry point for money movement. Writes the ledger row and moves the
 * balance in one statement pair; the caller supplies the transaction.
 *
 * During the free trial (see FREE_TRIAL_ENDS_AT / MONETIZATION_ENABLED) this is
 * a no-op for entry fees and prizes, so the rest of the code can call it
 * unconditionally and we flip one flag to go live.
 */
export async function postLedgerEntry(entry: LedgerEntry, client: Queryable): Promise<boolean> {
  // While the trial runs, gameplay charges are no-ops — but top-ups, goodwill
  // and promotional credits still move, so a balance can be built up before
  // charging begins.
  const isGameplayCharge =
    entry.kind === 'entry_fee' || entry.kind === 'prize' || entry.kind === 'game_charge';
  if (!isChargingEnabled() && isGameplayCharge) return false;
  if (entry.amountPaise === 0) return false;

  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO wallet_transactions
       (player_id, amount_paise, kind, reference_type, reference_id, idempotency_key, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      entry.playerId,
      entry.amountPaise,
      entry.kind,
      entry.referenceType ?? null,
      entry.referenceId ?? null,
      entry.idempotencyKey ?? null,
      entry.note ?? null,
      entry.createdBy ?? null,
    ],
    client,
  );

  // Already applied under this idempotency key — do not move the balance twice.
  if (!inserted) return false;

  const updated = await queryOne<{ balance_paise: string }>(
    `UPDATE wallets SET balance_paise = balance_paise + $2, updated_at = now()
     WHERE player_id = $1
     RETURNING balance_paise`,
    [entry.playerId, entry.amountPaise],
    client,
  );

  if (!updated) throw new Error(`No wallet for player ${entry.playerId}`);
  return true;
}

export async function hasSufficientBalance(
  playerId: string,
  amountPaise: number,
  client?: Queryable,
): Promise<boolean> {
  if (!isChargingEnabled() || amountPaise <= 0) return true;
  return (await getBalance(playerId, client)) >= amountPaise;
}

/* ----------------------------------------------------------- admin credits */

/**
 * Adds (or removes) credit from the admin panel.
 *
 * Deliberately not gated on `isChargingEnabled`: the whole point is to be able
 * to put credit in a wallet for a technical fault or a promotion, including
 * before charging ever begins.
 */
export async function adjustWallet(
  playerId: string,
  amountPaise: number,
  kind: LedgerKind,
  note: string,
  createdBy: string,
): Promise<{ balancePaise: number }> {
  return withTransaction(async (client) => {
    await query(
      `INSERT INTO wallet_transactions
         (player_id, amount_paise, kind, note, created_by, reference_type)
       VALUES ($1, $2, $3, $4, $5, 'admin')`,
      [playerId, amountPaise, kind, note.slice(0, 500), createdBy],
      client,
    );

    const updated = await queryOne<{ balance_paise: string }>(
      `UPDATE wallets SET balance_paise = GREATEST(balance_paise + $2, 0), updated_at = now()
        WHERE player_id = $1
        RETURNING balance_paise`,
      [playerId, amountPaise],
      client,
    );

    if (!updated) throw new Error(`No wallet for player ${playerId}`);
    return { balancePaise: Number(updated.balance_paise) };
  });
}

export async function listWallets(limit: number, offset: number): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT p.id, p.wa_id, p.display_name, w.balance_paise, w.free_games, w.updated_at,
            (SELECT count(*)::int FROM wallet_transactions t WHERE t.player_id = p.id) AS movements,
            (SELECT count(*)::int FROM games g WHERE g.host_player_id = p.id)          AS games_hosted
       FROM wallets w
       JOIN players p ON p.id = w.player_id
      ORDER BY w.balance_paise DESC, p.last_seen_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
}

export async function walletHistory(playerId: string, limit: number): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT t.created_at, t.amount_paise, t.kind, t.note, t.created_by,
            t.reference_type, g.room_code
       FROM wallet_transactions t
       LEFT JOIN games g ON g.id = t.reference_id
      WHERE t.player_id = $1
      ORDER BY t.created_at DESC
      LIMIT $2`,
    [playerId, limit],
  );
}

export async function walletTotals(): Promise<Record<string, unknown> | null> {
  return queryOne(
    `SELECT COALESCE(sum(balance_paise), 0)::text AS total_balance_paise,
            count(*) FILTER (WHERE balance_paise > 0)::int AS wallets_with_credit,
            COALESCE(sum(free_games), 0)::int AS free_games_outstanding,
            count(*) FILTER (WHERE free_games > 0)::int AS wallets_with_free_games,
            count(*)::int AS wallets
       FROM wallets`,
  );
}

/* -------------------------------------------------------------- free games */

/**
 * Comped games, counted separately from wallet money.
 *
 * A free game was never paid for, so putting its value into the wallet would
 * overstate both revenue and the credit liability. Counting games instead keeps
 * "money owed to players" honest.
 */
export async function grantFreeGames(
  playerId: string,
  quantity: number,
  reason: string,
  grantedBy: string,
  campaign?: string,
): Promise<{ freeGames: number }> {
  return withTransaction(async (client) => {
    await query(
      `INSERT INTO free_game_grants (player_id, quantity, reason, granted_by, campaign)
       VALUES ($1, $2, $3, $4, $5)`,
      [playerId, quantity, reason.slice(0, 500), grantedBy, campaign ?? null],
      client,
    );

    const updated = await queryOne<{ free_games: number }>(
      `UPDATE wallets SET free_games = GREATEST(free_games + $2, 0), updated_at = now()
        WHERE player_id = $1
        RETURNING free_games`,
      [playerId, quantity],
      client,
    );

    if (!updated) throw new Error(`No wallet for player ${playerId}`);
    return { freeGames: updated.free_games };
  });
}

export async function getFreeGames(playerId: string, client?: Queryable): Promise<number> {
  const row = await queryOne<{ free_games: number }>(
    'SELECT free_games FROM wallets WHERE player_id = $1',
    [playerId],
    client,
  );
  return row?.free_games ?? 0;
}

/**
 * Spends one comped game, if the player has any.
 *
 * Returns false when they do not, so the caller falls through to charging the
 * wallet. The UPDATE is conditional rather than read-then-write, so two draws
 * racing cannot spend the same comp twice.
 */
export async function consumeFreeGame(playerId: string, client: Queryable): Promise<boolean> {
  const row = await queryOne<{ free_games: number }>(
    `UPDATE wallets SET free_games = free_games - 1, updated_at = now()
      WHERE player_id = $1 AND free_games > 0
      RETURNING free_games`,
    [playerId],
    client,
  );
  return Boolean(row);
}

export async function listFreeGameGrants(limit: number): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT g.granted_at, g.quantity, g.reason, g.granted_by, g.campaign,
            p.wa_id, p.display_name, p.id AS player_id
       FROM free_game_grants g
       JOIN players p ON p.id = g.player_id
      ORDER BY g.granted_at DESC
      LIMIT $1`,
    [limit],
  );
}
