import { queryOne, type Queryable } from '../db/pool.js';
import { isChargingEnabled } from '../config/env.js';

export type LedgerKind = 'topup' | 'entry_fee' | 'prize' | 'refund' | 'adjustment';

export interface LedgerEntry {
  playerId: string;
  amountPaise: number; // positive credit, negative debit
  kind: LedgerKind;
  referenceType?: string;
  referenceId?: string;
  idempotencyKey?: string;
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
  if (!isChargingEnabled() && (entry.kind === 'entry_fee' || entry.kind === 'prize')) {
    return false;
  }
  if (entry.amountPaise === 0) return false;

  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO wallet_transactions (player_id, amount_paise, kind, reference_type, reference_id, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      entry.playerId,
      entry.amountPaise,
      entry.kind,
      entry.referenceType ?? null,
      entry.referenceId ?? null,
      entry.idempotencyKey ?? null,
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
